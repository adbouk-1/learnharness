/**
 * Side-effect module: point LH_DATA_DIR at a fresh tmp dir. Import it FIRST
 * in a test file that statically imports the app — ES imports evaluate in
 * source order, and config.ts binds the data root at module load, so this
 * keeps the test off the real data/ (e.g. a stored Ollama catalog).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-data-"));
process.env.LH_DATA_DIR = TMP_DATA_DIR;
