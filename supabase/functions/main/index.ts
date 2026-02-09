console.log("main function started");

Deno.serve(async (req: Request) => {
  const headers = new Headers({
    "Content-Type": "application/json",
  });

  const url = new URL(req.url);
  const { pathname } = url;

  if (pathname === "/_internal/health") {
    return new Response(
      JSON.stringify({ message: "ok" }),
      { status: 200, headers },
    );
  }

  if (pathname === "/_internal/metric") {
    const metric = await EdgeRuntime.getRuntimeMetrics();
    return Response.json(metric);
  }

  const pathParts = pathname.split("/");
  const serviceName = pathParts[1];

  if (!serviceName || serviceName === "") {
    return new Response(
      JSON.stringify({ msg: "missing function name in request" }),
      { status: 400, headers },
    );
  }

  const servicePath = `/home/deno/functions/${serviceName}`;

  const createWorker = async () => {
    const envVarsObj = Deno.env.toObject();
    const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]]);

    return await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb: 150,
      workerTimeoutMs: 5 * 60 * 1000,
      noModuleCache: false,
      envVars,
      forceCreate: false,
      cpuTimeSoftLimitMs: 10000,
      cpuTimeHardLimitMs: 20000,
    });
  };

  const callWorker = async (): Promise<Response> => {
    try {
      const worker = await createWorker();
      const controller = new AbortController();
      return await worker.fetch(req, { signal: controller.signal });
    } catch (e) {
      console.error(e);
      if (e instanceof Deno.errors.WorkerAlreadyRetired) {
        return await callWorker();
      }
      return new Response(
        JSON.stringify({ msg: String(e) }),
        { status: 500, headers },
      );
    }
  };

  return callWorker();
});
