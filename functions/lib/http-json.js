"use strict";

class JsonRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "JsonRequestError";
    this.status = status;
  }
}

function requestHeader(req, name) {
  if (typeof req.get === "function") return req.get(name);
  return req.headers?.[name.toLocaleLowerCase()];
}

function validateBoundedJsonRequest(req, maxBytes) {
  const contentEncoding = requestHeader(req, "content-encoding");
  if (
    typeof contentEncoding === "string" &&
    contentEncoding.trim() !== "" &&
    contentEncoding.trim().toLocaleLowerCase("en-US") !== "identity"
  ) {
    throw new JsonRequestError(415, "Compressed request bodies are not supported");
  }
  const contentType = requestHeader(req, "content-type");
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0].trim().toLocaleLowerCase("en-US") !==
      "application/json"
  ) {
    throw new JsonRequestError(415, "Content-Type must be application/json");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("The JSON request limit is invalid");
  }
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.length > maxBytes) {
    throw new JsonRequestError(413, `The JSON request must be ${maxBytes} bytes or fewer`);
  }
}

module.exports = {
  JsonRequestError,
  requestHeader,
  validateBoundedJsonRequest,
};
