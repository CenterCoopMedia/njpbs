"use strict";
// Invented guide data. No name, video, project, or file here belongs to station staff or
// station media. Posters reuse committed station artwork from site/public/brand/spotlight.
const asset = (id, name, originalName, description, durationSeconds, sizeBytes, rightsStatus, poster) => ({
  id, sourceId: "video-library", name, originalName, description, sizeBytes, rightsStatus, version: 4,
  viewingCopy: { state: "ready", durationSeconds }, poster: `site/public/brand/spotlight/${poster}`,
});

module.exports = {
  now: Date.parse("2026-08-20T15:00:00-04:00"),
  expiresAt: "2026-09-19T19:00:00.000Z",
  user: { uid: "guide-editor", displayName: "Alex Rivera" },
  premiereVersion: "26.5.2",
  uxpVersion: "9.3.0",
  projectName: "Shore erosion feature",
  userCode: "KXQR-7M2P",
  connected: true,
  pairing: "enabled",
  returnFile: "oyster-reef-package-v3.mp4",
  returnName: "Oyster reef restoration package v3",
  returnDescription: "Finished 2:10 package with lower thirds and mixed audio.",
  returnCredit: "NJ PBS",
  returnTags: "environment, Barnegat Bay, package",
  assets: [
    asset("oyster-reef-0912", "Barnegat Bay oyster reef b-roll", "A014_C003_0912.mov",
      "Reef cages at low tide and a volunteer crew. Shot from the boat and the shore.", 72, 100663296, "complete", "energy-environment.jpg"),
    asset("marsh-interview-0911", "Marsh restoration interview, project biologist", "A013_C001_0911.mov",
      "Two-camera sit-down interview. Lavalier on channel 1.", 1046, 6442450944, "pending", "energy-environment-02.jpg"),
    asset("shore-traffic-0910", "Route 72 causeway traffic, morning", "C0042.mp4",
      "Locked-off wide and tight shots of beach traffic.", 184, 1288490188, "complete", "business.jpg"),
    asset("statehouse-0909", "Statehouse exterior and hallway walk", "C0031.mp4",
      "Exterior establishing shots and a hallway walk.", 251, 1717986918, "complete", "budget.jpg"),
    asset("boardwalk-crowd-0907", "Boardwalk crowd wide shots", "A011_C007_0907.mov",
      "Late-afternoon crowds and storefronts.", 397, 2899102924, "pending", "housing.jpg"),
    asset("classroom-0905", "Classroom science lab cutaways", "C0019.mp4",
      "Hands, beakers and whiteboard close-ups. Faces not shown.", 133, 912680550, "complete", "education.jpg"),
  ],
  markers: {
    "oyster-reef-0912": [
      { startMs: 4000, endMs: 4000, name: "Crew arrives", comment: "Good opener", type: "Comment", color: 0 },
      { startMs: 18000, endMs: 46500, name: "Reef cage close-ups", comment: "", type: "Chapter", color: 3 },
      { startMs: 58250, endMs: 61000, name: "Gull flyover", comment: "Natural sound only", type: "Comment", color: 5 },
    ],
  },
};
