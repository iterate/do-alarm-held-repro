// A Durable Object alarm moved earlier with setAlarm() is sometimes not run at its time: it is held
// about 19, 39 or 58 s, while storage.getAlarm() keeps returning the overdue time. Calling setAlarm()
// again gets it run within ~100 ms; a storage write alone does not. One object per trial; run.mjs
// drives the trials.
import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {
  // A new value each time the runtime constructs the object: tells incarnations apart.
  instance = crypto.randomUUID().slice(0, 8);

  // shape=move, call 1: arm the alarm `laterMs` out (the object's first setAlarm).
  async armLater(laterMs) {
    const at = Date.now() + laterMs;
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  // Call 2 for shape=move (moves the alarm EARLIER), the only call for shape=single.
  async arm(soonMs, laterAt) {
    const target = Date.now() + soonMs;
    this.ctx.storage.put({ target, laterAt, armInstance: this.instance });
    await this.ctx.storage.setAlarm(target);
    return { target, instance: this.instance };
  }

  async alarm(info) {
    const at = Date.now();
    const deliveries = (await this.ctx.storage.get("deliveries")) ?? [];
    deliveries.push({ at, instance: this.instance, retryCount: info?.retryCount ?? 0 });
    await this.ctx.storage.put("deliveries", deliveries);
  }

  // getAlarm is the runtime's own view of the armed alarm.
  async status() {
    const s = await this.ctx.storage.get(["target", "laterAt", "armInstance", "deliveries"]);
    return {
      now: Date.now(),
      instance: this.instance,
      getAlarm: await this.ctx.storage.getAlarm(),
      target: s.get("target") ?? null,
      laterAt: s.get("laterAt") ?? null,
      armInstance: s.get("armInstance") ?? null,
      deliveries: s.get("deliveries") ?? [],
    };
  }

  // Poke a held alarm. to=next: setAlarm(now + 1 ms), a different time. to=same: setAlarm(the
  // stored time) again. to=put: no setAlarm, one storage.put() of an unrelated key.
  async rearm(to) {
    const before = await this.ctx.storage.getAlarm();
    const at = Date.now();
    if (to === "put") await this.ctx.storage.put("poke", at);
    else if (to === "next") await this.ctx.storage.setAlarm(at + 1);
    else if (before !== null) await this.ctx.storage.setAlarm(before); // same; null: nothing is armed
    return { at, to, getAlarmBefore: before, instance: this.instance };
  }

  // The colo this object runs in.
  async colo() {
    const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
    return /^colo=(\w+)$/m.exec(trace)?.[1] ?? null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const q = (name, fallback) => url.searchParams.get(name) ?? fallback;
    const name = q("id");
    if (!name) return new Response("GET /arm|/status|/rearm|/colo ?id=<unique name>\n", { status: 400 });
    const id = env.PROBE.idFromName(name);
    const hint = q("hint");
    const stub = env.PROBE.get(id, hint ? { locationHint: hint } : undefined);
    switch (url.pathname) {
      case "/arm": {
        // shape=move: +60 s, then +1.5 s in a second RPC call, `pause` ms later (default 0).
        // shape=single: +1.5 s only.
        const laterAt = q("shape", "move") === "move" ? await stub.armLater(Number(q("later", 60000))) : null;
        if (laterAt && Number(q("pause", 0))) await new Promise((resolve) => setTimeout(resolve, Number(q("pause"))));
        const armed = await stub.arm(Number(q("soon", 1500)), laterAt);
        return Response.json({ doId: id.toString(), laterAt, ...armed });
      }
      case "/status":
        return Response.json(await stub.status());
      case "/rearm":
        return Response.json(await stub.rearm(q("to", "next")));
      case "/colo":
        return Response.json({ colo: await stub.colo() });
    }
    return new Response("not found\n", { status: 404 });
  },
};
