// A Durable Object alarm is sometimes not delivered at its time: it is held 10-60 s, while
// storage.getAlarm() keeps returning the overdue time. Writing a different time with setAlarm()
// gets it delivered within ~50 ms. One object per trial; run.mjs drives the trials.
import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {
  // A new value each time the runtime constructs the object: tells incarnations apart.
  instance = crypto.randomUUID().slice(0, 8);

  // shape=move, request 1: arm the alarm `laterMs` out (the object's first setAlarm).
  async armLater(laterMs) {
    const at = Date.now() + laterMs;
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  // Request 2 for shape=move (moves the alarm EARLIER), the only request for shape=single.
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
    const s = await this.ctx.storage.get(["target", "laterAt", "armInstance", "rearms", "deliveries"]);
    return {
      now: Date.now(),
      instance: this.instance,
      getAlarm: await this.ctx.storage.getAlarm(),
      target: s.get("target") ?? null,
      laterAt: s.get("laterAt") ?? null,
      armInstance: s.get("armInstance") ?? null,
      rearms: s.get("rearms") ?? [],
      deliveries: s.get("deliveries") ?? [],
    };
  }

  // to=next writes now + 1 ms (a different time); to=same writes the stored time again.
  async rearm(to) {
    const before = await this.ctx.storage.getAlarm();
    const at = Date.now();
    const alarmAt = to === "same" ? before : at + 1;
    const rearms = (await this.ctx.storage.get("rearms")) ?? [];
    rearms.push({ at, to, alarmAt, getAlarmBefore: before, instance: this.instance });
    this.ctx.storage.put("rearms", rearms);
    if (alarmAt !== null) await this.ctx.storage.setAlarm(alarmAt);
    return rearms.at(-1);
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
        // shape=move: +60 s, then +1.5 s in a second request. shape=single: +1.5 s only.
        const laterAt = q("shape", "move") === "move" ? await stub.armLater(Number(q("later", 60000))) : null;
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
