const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

if (process.env.CAPYBARA_PATH_GUARD !== "off") {
  let configured = [];
  try { configured = JSON.parse(process.env.CAPYBARA_ALLOWED_ROOTS || "[]"); } catch { configured = []; }
  function canonical(value) {
    const text = value instanceof URL ? value.toString() : String(value);
    const parsed = text.startsWith("file://") ? decodeURIComponent(new URL(text).pathname) : text;
    const windowsPath = parsed.replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", path.sep);
    return path.resolve(windowsPath);
  }

  const roots = [...configured, process.cwd()]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => canonical(value));

  function allowed(value) {
    if (typeof value !== "string" && !Buffer.isBuffer(value) && !(value instanceof URL)) return true;
    const absolute = canonical(value);
    return roots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`));
  }

  function assertAllowed(value) {
    if (!allowed(value)) {
      const error = new Error(`Capybara application path is outside its allowed roots: ${String(value)}`);
      error.code = "CAPYBARA_PATH_DENIED";
      throw error;
    }
  }

  for (const name of ["access", "chmod", "chown", "copyFile", "cp", "lstat", "mkdir", "open", "readFile", "readdir", "rename", "rm", "stat", "unlink", "utimes", "writeFile", "accessSync", "chmodSync", "chownSync", "copyFileSync", "cpSync", "lstatSync", "mkdirSync", "openSync", "readFileSync", "readdirSync", "renameSync", "rmSync", "statSync", "unlinkSync", "utimesSync", "writeFileSync", "createReadStream", "createWriteStream"]) {
    const original = fs[name];
    if (typeof original !== "function") continue;
    fs[name] = function guardedFilesystemCall(first, ...rest) {
      assertAllowed(first);
      if (["copyFile", "copyFileSync", "cp", "cpSync", "rename", "renameSync"].includes(name)) assertAllowed(rest[0]);
      return original.call(this, first, ...rest);
    };
  }

  const originalExistsSync = fs.existsSync;
  fs.existsSync = function guardedExistsSync(first) {
    if (!allowed(first)) return false;
    return originalExistsSync.call(this, first);
  };

  if (fs.promises) {
    for (const name of ["access", "chmod", "chown", "copyFile", "cp", "lstat", "mkdir", "open", "readFile", "readdir", "rename", "rm", "stat", "unlink", "utimes", "writeFile"]) {
      const original = fs.promises[name];
      if (typeof original !== "function") continue;
      fs.promises[name] = async function guardedPromiseFilesystemCall(first, ...rest) {
        assertAllowed(first);
        if (["copyFile", "cp", "rename"].includes(name)) assertAllowed(rest[0]);
        return original.call(this, first, ...rest);
      };
    }
  }
}
