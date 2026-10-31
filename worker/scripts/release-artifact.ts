import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { MAX_PACKAGE_BYTES } from "../src/package-source.ts";

/** Read the opened regular file, with a hard bound even if it grows after fstat. */
const readBounded = (path: string, maximum: number): Buffer => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error("The release artifact is not a bounded regular file");
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maximum) throw new Error("The release artifact exceeds its size limit");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
};

/** Downloaded release files at the Operator's filesystem boundary; never follows links. */
export const readReleaseArtifact = (directory: string) => ({
  zip: readBounded(join(directory, "gq-support.zip"), MAX_PACKAGE_BYTES),
  manifest: readBounded(join(directory, "gq-support.manifest.json"), 1024 * 1024).toString("utf8"),
  provenance: readBounded(join(directory, "provenance.json"), 1024 * 1024).toString("utf8"),
});
