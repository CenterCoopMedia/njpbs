// Exact Git blob IDs, not commit ancestry. Every new whole-file version needs
// a reviewed allowlist entry with its review provenance.
export const REHEARSAL_HOLD_OWNER_BLOBS = Object.freeze(Object.fromEntries(Object.entries({
  'functions/lib/public-release-rehearsal-hold.js': [
    { blob: '017be0ac0de3bd690c5e57ad08a2b6e8949f11ff', reviewedIn: '#4443' },
  ],
  'functions/lib/public-release-admission.js': [
    { blob: 'a50edf43d30b72a3066e03bf7459c39bd59db12d', reviewedIn: '#4443' },
    { blob: '437aa9294dc09055ce1bfecddd70ff509749afc7', reviewedIn: '#4474' },
    { blob: 'e4fc8071bd394cc48324f69b064d1c91898cb84e', reviewedIn: '#4545' },
  ],
  'site/scripts/public-release-original-continuation.ts': [
    { blob: '9d63f973df10ca003770cecbfe155e87dde664a4', reviewedIn: '#4443' },
  ],
  'site/scripts/public-release-publication-terminal.ts': [
    { blob: '3fa59887da2f3ed2e1a259ed7835ae89cb6a75b9', reviewedIn: '#4659' },
    { blob: 'e4b22f85bfa2278cf53706ae2b6f9163a798ac5e', reviewedIn: '#4443' },
    { blob: '24147c5a98d7a11382a960e9b57c2f482d41a0a0', reviewedIn: '#50' },
  ],
}).map(([file, entries]) => [file, Object.freeze(entries.map(entry => Object.freeze(entry)))])));
