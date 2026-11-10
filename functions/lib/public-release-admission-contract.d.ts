import type admission from "./public-release-admission";

/** Worker-safe codecs from the same implementation used by the SDK owner. */
declare const contract: Pick<typeof admission, "ADMISSIONS" | "CONTRACTS" | "parseAdmission" | "assertQueue" | "parseAdmissionHead" | "initialAdmissionHead">;
export default contract;
