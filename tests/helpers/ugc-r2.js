import intake from "../../functions/ugc-intake.js";

// S3 transport boundary: conditional PUT commits against the current object,
// HEAD returns the provider's ContentLength/ETag/Metadata shape, and 404/412 are
// provider errors. No quota or handler logic is replaced by this fixture.
export function ugcBucket() {
  const objects = new Map();
  const hooks = { beforeSend: null, afterSend: null };
  let revision = 0;
  const failure = (code) => Object.assign(new Error(`R2 ${code}`), {
    name: code === 404 ? "NotFound" : "PreconditionFailed", $metadata: { httpStatusCode: code },
  });
  const client = { async send(command) {
    await hooks.beforeSend?.(command);
    const input = command.input;
    const current = objects.get(input.Key);
    let result;
    switch (command.constructor.name) {
      case "HeadObjectCommand":
        if (!current) throw failure(404);
        result = { ...current };
        break;
      case "PutObjectCommand":
        if (input.IfNoneMatch === "*" && current) throw failure(412);
        objects.set(input.Key, { ContentLength: input.ContentLength,
          ETag: `"object-${++revision}"`, Metadata: input.Metadata ?? {} });
        result = {};
        break;
      case "DeleteObjectCommand":
        objects.delete(input.Key);
        result = {};
        break;
      default: throw new Error(`Unexpected storage operation: ${command.constructor.name}`);
    }
    await hooks.afterSend?.(command);
    return result;
  } };
  const storage = intake.createUgcStorage({ client, bucket: "quota-test",
    sign: async (_client, command) => `https://upload.example.test/${command.input.Key}` });
  return { storage, objects, hooks, client };
}
