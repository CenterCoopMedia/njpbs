const safeErrorTypes = [AggregateError, TypeError, SyntaxError, RangeError, ReferenceError, URIError, EvalError, Error];

function safeErrorClass(error) {
  try {
    return safeErrorTypes.find(type => error instanceof type)?.name ?? "Unknown";
  } catch {
    return "Unknown";
  }
}

function writeResult(result) {
  const receipt = `${JSON.stringify(result)}\n`;
  return new Promise((resolve, reject) => {
    process.stdout.once("error", reject);
    process.stdout.write(receipt, error => {
      if (error) reject(error);
      else {
        process.stdout.removeListener("error", reject);
        resolve();
      }
    });
  });
}

// Call once from the CLI entrypoint. Keep the listener through process exit so
// an orphaned Firestore transaction-ID rejection cannot interrupt cleanup.
export async function runReadOnlyOperator({ stage, run, refusal }) {
  let firstFailure;
  let finished = false;
  let reported = false;
  const emit = () => {
    if (!firstFailure || reported) return;
    reported = true;
    process.stderr.write(`${refusal(firstFailure)}\n`);
  };
  const remember = error => {
    firstFailure ??= { stage, errorClass: safeErrorClass(error) };
    process.exitCode = 1;
    if (finished) emit();
  };
  const nextTurn = () => new Promise(resolve => setImmediate(resolve));
  process.on("unhandledRejection", remember);
  try {
    const result = await run(value => { stage = value; });
    await nextTurn();
    if (firstFailure) return;
    stage = "result-write";
    await writeResult(result);
  } catch (error) {
    remember(error);
  } finally {
    await nextTurn();
    finished = true;
    emit();
  }
}

export async function withOperatorDatabase({ stage, openCredential, openDatabase, run }) {
  stage("credential-open");
  const credential = openCredential();
  let connection, result, failure;
  try {
    stage("credential-read");
    const account = await credential.read();
    stage("database-open");
    connection = await openDatabase(account);
    result = await run(connection.firestore);
  } catch (error) {
    failure = { error };
  }

  // Keep the first failure and its stage, and attempt both cleanups.
  if (!failure) stage("credential-close");
  try { credential.close(); }
  catch (error) { failure ??= { error }; }
  if (!failure && connection) stage("database-close");
  try { await connection?.close(); }
  catch (error) { failure ??= { error }; }
  if (failure) throw failure.error;
  return result;
}
