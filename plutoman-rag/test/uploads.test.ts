/**
 * Demo uploads + access codes — pure helpers, no database or Redis.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadKey, validateUpload } from "../src/uploads";
import { parseAccessCodes } from "../src/accessCodes";
import { config } from "../src/config";

test("uploadKey: strips paths, control characters and citation brackets", () => {
  assert.equal(uploadKey(String.raw`C:\fakepath\Report [v2].pdf`), "Report v2.pdf");
  assert.equal(uploadKey("../../etc/passwd.txt"), "passwd.txt");
  assert.equal(uploadKey("a\u0000b\u001fc.csv"), "abc.csv");
  assert.equal(uploadKey("   "), "upload");
});

test("validateUpload: allows the supported formats only", () => {
  assert.equal(validateUpload("inspection.XLSX", 1000), null);
  assert.equal(validateUpload("sop.pdf", 1000), null);
  assert.match(validateUpload("photo.jpg", 1000) ?? "", /Unsupported/);
  assert.match(validateUpload("macro.xlsm", 1000) ?? "", /Unsupported/);
});

test("validateUpload: enforces empty and size limits", () => {
  assert.match(validateUpload("a.pdf", 0) ?? "", /empty/);
  assert.match(validateUpload("a.pdf", config.UPLOAD_MAX_MB * 1024 * 1024 + 1) ?? "", /limit/);
});

test("parseAccessCodes: tenant=code pairs; malformed and short codes ignored", () => {
  assert.deepEqual(parseAccessCodes("plutomen=Secret-123; okra=Another-456"), [
    { tenant: "plutomen", code: "Secret-123" },
    { tenant: "okra", code: "Another-456" },
  ]);
  assert.deepEqual(parseAccessCodes("nocode; =x; t=short; ;"), []);
  assert.deepEqual(parseAccessCodes(""), []);
});
