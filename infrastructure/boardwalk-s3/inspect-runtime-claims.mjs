const metadataUrl = new URL(
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
);
metadataUrl.searchParams.set("audience", "njpbs-boardwalk-s3");
metadataUrl.searchParams.set("format", "full");

const response = await fetch(metadataUrl, {
  headers: { "Metadata-Flavor": "Google" },
});
if (!response.ok) {
  throw new Error(`Google metadata identity request failed with ${response.status}`);
}

const token = await response.text();
const parts = token.split(".");
if (parts.length !== 3) {
  throw new Error("Google metadata identity response was not a JWT");
}

const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
const allowedClaims = ["iss", "aud", "azp", "sub", "email", "email_verified"];
const inspection = Object.fromEntries(
  allowedClaims.filter((name) => claims[name] !== undefined).map((name) => [name, claims[name]]),
);

if (inspection.aud !== "njpbs-boardwalk-s3") {
  throw new Error("Google token audience did not match the fixed Boardwalk audience");
}

console.log(JSON.stringify(inspection));
