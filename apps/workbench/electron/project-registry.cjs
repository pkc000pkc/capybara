const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createProjectRegistry({ refFactory = () => `directory:${crypto.randomUUID()}`, projectFactory = () => `project:${crypto.randomUUID()}`, storageFile } = {}) {
  const records = new Map();

  function pathKey(value) {
    const normalized = path.normalize(path.resolve(value));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }

  if (storageFile && fs.existsSync(storageFile)) {
    try {
      const persisted = JSON.parse(fs.readFileSync(storageFile, "utf8"));
      if (Array.isArray(persisted)) {
        for (const [index, record] of persisted.entries()) {
          if (record && typeof record.ref === "string" && typeof record.selectedPath === "string" && typeof record.projectId === "string" && typeof record.displayName === "string" && typeof record.isEmpty === "boolean") {
            records.set(record.ref, { selectedPath: path.resolve(record.selectedPath), projectId: record.projectId, displayName: record.displayName, isEmpty: record.isEmpty, lastOpenedAt: typeof record.lastOpenedAt === "string" ? record.lastOpenedAt : `1970-01-01T00:00:00.${String(index).padStart(3, "0")}Z` });
          }
        }
      }
    } catch {
      // Corrupt indexes are treated as empty; the source directories are not touched.
    }
  }

  function persist() {
    if (!storageFile) return;
    fs.mkdirSync(path.dirname(storageFile), { recursive: true });
    const temporary = `${storageFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify([...records.entries()].map(([ref, record]) => ({ ref, ...record })), null, 2)}\n`, "utf8");
    fs.renameSync(temporary, storageFile);
  }

  return {
    createSelection({ selectedPath, displayName, isEmpty }) {
      const resolvedPath = path.resolve(selectedPath);
      const lastOpenedAt = new Date().toISOString();
      const existing = [...records.entries()].find(([, record]) => pathKey(record.selectedPath) === pathKey(resolvedPath));
      if (existing) {
        const [opaqueDirectoryRef, record] = existing;
        const updated = { ...record, selectedPath: resolvedPath, displayName, isEmpty, lastOpenedAt };
        records.set(opaqueDirectoryRef, updated);
        persist();
        return { projectId: updated.projectId, displayName: updated.displayName, isEmpty: updated.isEmpty, opaqueDirectoryRef };
      }
      const opaqueDirectoryRef = refFactory();
      const projectId = projectFactory();
      records.set(opaqueDirectoryRef, { selectedPath: resolvedPath, displayName, isEmpty, projectId, lastOpenedAt });
      persist();
      return { projectId, displayName, isEmpty, opaqueDirectoryRef };
    },

    registerSelection(selection) {
      if (!selection || typeof selection !== "object") throw new Error("project selection is required");
      if (typeof selection.opaqueDirectoryRef !== "string" || selection.opaqueDirectoryRef.length === 0) {
        throw new Error("opaque directory reference is required");
      }
      const record = records.get(selection.opaqueDirectoryRef);
      if (!record) throw new Error("opaque directory reference is unknown or expired");
      return {
        projectId: record.projectId,
        displayName: record.displayName,
        isEmpty: record.isEmpty,
        source: "native-directory-picker",
      };
    },

    has(ref) { return records.has(ref); },
    getRecord(ref) {
      const record = records.get(ref);
      return record ? { ...record } : undefined;
    },
    resolvePath(ref) { return records.get(ref)?.selectedPath; },
    remove(ref) {
      const record = records.get(ref);
      if (!record) return undefined;
      records.delete(ref);
      persist();
      return { ref, ...record };
    },
    snapshot() { return [...records.entries()].map(([ref, record]) => ({ ref, ...record })); },
    listExisting() {
      let changed = false;
      for (const [ref, record] of records.entries()) {
        try {
          if (!fs.statSync(record.selectedPath).isDirectory()) {
            records.delete(ref);
            changed = true;
          } else {
            const isEmpty = fs.readdirSync(record.selectedPath).every(name => name === '.capybara');
            if (record.isEmpty !== isEmpty) {
              record.isEmpty = isEmpty;
              changed = true;
            }
          }
        } catch {
          records.delete(ref);
          changed = true;
        }
      }
      if (changed) persist();
      return [...records.entries()]
        .map(([ref, record]) => ({ ref, ...record }))
        .sort((a, b) => String(b.lastOpenedAt || "").localeCompare(String(a.lastOpenedAt || "")));
    },
  };
}

module.exports = { createProjectRegistry };
