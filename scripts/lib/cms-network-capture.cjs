function serverDurations(header) {
  if (header === null) return null;
  // Split outside quoted descriptions so their punctuation cannot add metrics.
  const metrics = header.match(/(?:[^,"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
  return metrics.flatMap((metric) => {
    const [name, ...parameters] =
      metric.match(/(?:[^;"]|"(?:[^"\\]|\\.)*")+/g) ?? [];
    const duration = parameters.find((parameter) =>
      /^\s*dur\s*=/i.test(parameter),
    );
    const value = duration?.match(
      /^\s*dur\s*=\s*"?(\d+(?:\.\d+)?)"?\s*$/i,
    )?.[1];
    if (!/^[\w-]+$/.test(name?.trim()) || value === undefined) return [];
    return [{ name: name.trim(), durationMs: Number(value) }];
  });
}

// Attribute requests at start, before preparatory navigation can cross a sample boundary.
function createCmsNetworkCapture(page) {
  const requestEpochs = new WeakMap();
  let epoch = 0;
  let capture;

  page.on("request", (request) => {
    requestEpochs.set(request, capture?.epoch ?? 0);
  });

  function destination(request) {
    if (!capture || new URL(request.url()).hostname !== "api.example.org")
      return;
    const requestEpoch = requestEpochs.get(request) ?? 0;
    return {
      capture,
      calls:
        requestEpoch === capture.epoch ? capture.calls : capture.carryInCalls,
      entry: { endpoint: new URL(request.url()).pathname, requestEpoch },
    };
  }

  page.on("requestfinished", (request) => {
    const target = destination(request);
    if (!target) return;
    const task = (async () => {
      try {
        const response = await request.response();
        const timing = request.timing();
        const header = await response.headerValue("server-timing");
        target.calls.push({
          ...target.entry,
          status: response.status(),
          durationMs: Math.round(timing.responseEnd),
          ttfbMs: Math.round(timing.responseStart),
          bytes: (await request.sizes()).responseBodySize,
          serverTiming: serverDurations(header),
        });
      } catch {
        target.calls.push({ ...target.entry, status: 0, failed: true });
      }
    })();
    target.capture.pending.add(task);
    void task.finally(() => target.capture.pending.delete(task));
  });

  page.on("requestfailed", (request) => {
    const target = destination(request);
    if (target) target.calls.push({ ...target.entry, status: 0, failed: true });
  });

  return {
    start() {
      capture = {
        epoch: ++epoch,
        calls: [],
        carryInCalls: [],
        pending: new Set(),
      };
    },
    async finish() {
      const finished = capture;
      capture = undefined;
      await Promise.all(finished.pending);
      return {
        captureEpoch: finished.epoch,
        calls: finished.calls,
        carryInCalls: finished.carryInCalls,
      };
    },
  };
}

module.exports = { createCmsNetworkCapture };
