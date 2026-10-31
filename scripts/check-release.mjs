import fs from "node:fs";

const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_LEADING_ZERO = /^0\d+$/;
const MANIFEST_VERSION = /^version\s*=\s*"([^"]+)"\s*$/m;
const tag = process.argv[2];
const match = tag?.match(RELEASE_TAG);
if (!match || match[4]?.split(".").some((part) => NUMERIC_LEADING_ZERO.test(part))) {
  throw new Error("Expected a release tag such as v0.1.0 or v0.2.0-rc.1 (no build metadata).");
}

const version = tag.slice(1);
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const manifest = fs.readFileSync(new URL("../herdr-plugin.toml", import.meta.url), "utf8");
const manifestVersion = manifest.match(MANIFEST_VERSION)?.[1];
if (pkg.version !== version || manifestVersion !== version) {
  throw new Error(`Tag ${tag} requires package.json and herdr-plugin.toml versions to both be ${version}; found ${pkg.version} and ${manifestVersion ?? "missing"}.`);
}
console.log(`Release ${tag}: package.json and herdr-plugin.toml versions match.`);
