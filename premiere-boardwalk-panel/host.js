"use strict";

const uxp = require("uxp");
const premiere = require("premierepro");
const fs = require("fs");
const { safeFilename, download } = require("./transfer.js");
const { expectedError } = require("./reports.js");
const { sha256 } = require("js-sha256");
const os = require("os");
const local = uxp.storage.localFileSystem;

function reportEnvironment() {
  return { pluginVersion: uxp.versions?.plugin || require("./manifest.json").version,
    premiereVersion: uxp.host?.version, uxpVersion: uxp.versions?.uxp, platform: os.platform() };
}

let diagnosticFolder;
async function diagnosticsFolder() {
  if (!diagnosticFolder) {
    diagnosticFolder = local.getDataFolder().then(async folder => {
      for (const entry of await folder.getEntries()) {
        if (!entry.isFile || !/^boardwalk-diagnostics-[a-f0-9]{64}\.json(?:\.tmp)?$/.test(entry.name)) continue;
        const metadata = await entry.getMetadata();
        if (Date.now() - new Date(metadata.dateModified).getTime() > 86400000) await entry.delete();
      }
      return folder;
    }).catch(error => { diagnosticFolder = null; throw error; });
  }
  return diagnosticFolder;
}
const diagnosticStore = {
  async read(uid) {
    const folder = await diagnosticsFolder();
    const name = `boardwalk-diagnostics-${sha256(uid)}.json`;
    const entry = (await folder.getEntries()).find(item => item.name === name && item.isFile);
    if (!entry || (await entry.getMetadata()).size > 65536) return null;
    return entry.read();
  },
  async write(uid, text) {
    const folder = await diagnosticsFolder();
    const name = `boardwalk-diagnostics-${sha256(uid)}.json`;
    const temporary = await folder.createFile(`${name}.tmp`, { overwrite: true });
    await temporary.write(text);
    await folder.renameEntry(temporary, name, { overwrite: true });
  },
};

async function activeProject() {
  const project = await premiere.Project.getActiveProject();
  if (!project) throw expectedError("Open a Premiere project, then try again.");
  return project;
}

async function cacheFolder({ choose = false } = {}) {
  if (!choose) {
    const token = localStorage.getItem("boardwalk-cache-folder");
    if (token) {
      try {
        const entry = await local.getEntryForPersistentToken(token);
        await entry.getEntries();
        return entry;
      } catch {
        throw new Error("Your cache folder is unavailable. Choose it again in Settings.");
      }
    }
  }
  const parent = await local.getFolder();
  if (!parent) return null;
  const entries = await parent.getEntries();
  let folder = entries.find(entry => entry.name === "Boardwalk");
  if (folder && !folder.isFolder) throw new Error("A file named Boardwalk already exists here. Choose another folder.");
  folder ||= await parent.createFolder("Boardwalk");
  localStorage.setItem("boardwalk-cache-folder", await local.createPersistentToken(folder));
  return folder;
}

async function importFile(file, expectedProject) {
  const project = await activeProject();
  if (expectedProject && project.guid.toString() !== expectedProject.guid.toString()) {
    throw expectedError("The active project changed. The file is cached; import it into the intended project.");
  }
  const bin = await project.getInsertionBin() || await project.getRootItem();
  const imported = await project.importFiles([file.nativePath], true, bin, false);
  if (!imported) throw new Error("Premiere could not import this file. It remains in your cache.");
  return project.name;
}

async function downloadToCache({ asset, access, expectedBytes, signal, onProgress, label }) {
  const folder = await cacheFolder();
  if (!folder) throw expectedError("Choose a cache folder to download media.");
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  const name = safeFilename(`${asset.id}-${suffix}-${label || asset.originalName}`);
  const partialName = `${name}.partial`;
  // UXP fs needs its scoped URL; raw Windows paths fail even for a chosen folder.
  // createFile returns a virtual entry; download's exclusive open creates the disk file.
  const path = local.getFsUrl(await folder.createFile(partialName, { overwrite: false }));
  let created = false;
  try {
    await download({ fs, url: access.url, path, expectedBytes, signal, onProgress, onCreated: () => { created = true; } });
  } catch (error) {
    // Only remove the incomplete file this attempt created with exclusive open.
    if (created) {
      try { await (await folder.getEntry(partialName)).delete(); }
      catch { error.message += " An incomplete .partial file remains in the cache."; }
    }
    throw error;
  }
  const file = await folder.getEntry(partialName);
  await folder.renameEntry(file, name, { overwrite: false });
  return folder.getEntry(name);
}

async function selectVideo() {
  return local.getFileForOpening({ types: ["mp4", "mov", "m4v", "mxf", "webm", "mpeg", "mpg", "mkv", "avi", "wmv"] });
}

async function selectedClip() {
  const project = await activeProject();
  const selection = await premiere.ProjectUtils.getSelection(project);
  const items = await selection.getItems();
  if (items.length !== 1) throw expectedError("Select one downloaded clip in Premiere's Project panel.");
  const clip = premiere.ClipProjectItem.cast(items[0]);
  if (!clip || await clip.isSequence() || await clip.isMergedClip() || await clip.isMulticamClip()) {
    throw expectedError("Select a source clip, not a sequence, merged clip, or multicam clip.");
  }
  return { project, clip, path: await clip.getMediaFilePath() };
}

function markerData(marker) {
  if (marker.getType() === "WebLink") throw Object.assign(expectedError("WebLink markers cannot round-trip because Premiere cannot restore their URL and target. Keep them in Premiere."), { code: "weblink_unsupported" });
  const startMs = Math.round(marker.getStart().seconds * 1000);
  return { startMs, endMs: startMs + Math.round(marker.getDuration().seconds * 1000),
    name: marker.getName(), comment: marker.getComments(), type: marker.getType(), color: marker.getColorIndex() };
}

async function readMarkers(selection) {
  const collection = await premiere.Markers.getMarkers(selection.clip);
  return collection.getMarkers().map(markerData);
}

async function replaceMarkers(selection, markers) {
  const collection = await premiere.Markers.getMarkers(selection.clip);
  const { project } = selection;
  let undoSteps = 0;
  project.lockedAccess(() => {
    if (markers.some(marker => marker.type === "WebLink") ||
        collection.getMarkers().some(marker => marker.getType() === "WebLink")) {
      throw expectedError("This clip has WebLink markers that Premiere cannot restore. Its markers have not been changed.");
    }
    if (!collection.getMarkers().length && !markers.length) return;
    const ok = project.executeTransaction(compound => {
      for (const marker of collection.getMarkers()) compound.addAction(collection.createRemoveMarkerAction(marker));
      for (const marker of markers) {
        compound.addAction(collection.createAddMarkerAction(marker.name, marker.type,
          premiere.TickTime.createWithSeconds(marker.startMs / 1000),
          premiere.TickTime.createWithSeconds((marker.endMs - marker.startMs) / 1000), marker.comment));
      }
    }, "Apply Boardwalk markers");
    if (!ok) throw new Error("Premiere could not apply these markers.");
    undoSteps = 1;
    // Marker handles exist only after the add transaction commits.
    const pending = [...markers];
    const colors = collection.getMarkers().map(marker => {
      const data = markerData(marker);
      const index = pending.findIndex(candidate => candidate.name === data.name && candidate.comment === data.comment &&
        candidate.type === data.type && Math.abs(candidate.startMs - data.startMs) <= 1 && Math.abs(candidate.endMs - data.endMs) <= 1);
      if (index < 0) throw new Error("Markers were added, but colors could not be matched. Undo Apply Boardwalk markers to restore your clip.");
      return { marker, color: pending.splice(index, 1)[0].color };
    });
    if (colors.length && !project.executeTransaction(compound => {
      for (const { marker, color } of colors) compound.addAction(marker.createSetColorByIndexAction(color));
    }, "Apply Boardwalk marker colors")) throw new Error("Markers were added, but colors failed. Undo both Boardwalk marker actions to restore your clip.");
    if (colors.length) undoSteps = 2;
  });
  return undoSteps;
}

module.exports = { uxp, premiere, fs, local, reportEnvironment, diagnosticStore, activeProject, cacheFolder, importFile, downloadToCache, selectVideo,
  selectedClip, readMarkers, replaceMarkers };
