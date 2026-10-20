"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FileIntakeValidator,
  checkFiles,
  MAX_FILES,
  MAX_SINGLE_MEDIA_BASE64,
  MAX_TOTAL_MEDIA_BASE64,
  MAX_SINGLE_TEXT_CHARS,
  MAX_TOTAL_TEXT_CHARS
} = require("../services/file-intake");

test("FileIntakeValidator: returns empty files when input is null or undefined", () => {
  const resultNull = checkFiles(null);
  assert.equal(resultNull.error, null);
  assert.deepEqual(resultNull.files, []);
  assert.equal(resultNull.stats.mediaCount, 0);

  const resultUndef = checkFiles(undefined);
  assert.equal(resultUndef.error, null);
  assert.deepEqual(resultUndef.files, []);
});

test("FileIntakeValidator: rejects attachment count exceeding MAX_FILES", () => {
  const files = [
    { name: "f1.txt", type: "text/plain", text: "1" },
    { name: "f2.txt", type: "text/plain", text: "2" },
    { name: "f3.txt", type: "text/plain", text: "3" },
    { name: "f4.txt", type: "text/plain", text: "4" },
    { name: "f5.txt", type: "text/plain", text: "5" }
  ];
  const result = checkFiles(files);
  assert.ok(result.error);
  assert.match(result.error, /Attach up to 4 files/);
  assert.deepEqual(result.files, []);
});

test("FileIntakeValidator: validates filename and MIME structure", () => {
  // Empty name
  assert.ok(checkFiles([{ name: "", type: "text/plain", text: "hi" }]).error);
  // Extremely long name (> 160 chars)
  assert.ok(checkFiles([{ name: "a".repeat(161), type: "text/plain", text: "hi" }]).error);
  // Missing type
  assert.ok(checkFiles([{ name: "file.txt", text: "hi" }]).error);
  // Unsupported type
  const badType = checkFiles([{ name: "app.exe", type: "application/octet-stream", data: "AAAA" }]);
  assert.ok(badType.error);
  assert.match(badType.error, /not supported/);
});

test("FileIntakeValidator: validates valid base64 media and tracks byte budget", () => {
  const validBase64 = Buffer.from("fake image data").toString("base64");
  const result = checkFiles([
    { name: "photo.png", type: "image/png", data: validBase64 },
    { name: "doc.pdf", type: "application/pdf", data: validBase64 }
  ]);

  assert.equal(result.error, null);
  assert.equal(result.files.length, 2);
  assert.equal(result.stats.mediaCount, 2);
  assert.equal(result.stats.textCount, 0);
  assert.equal(result.stats.totalMediaBase64, validBase64.length * 2);
});

test("FileIntakeValidator: rejects corrupt or invalid base64 media", () => {
  const corruptBase64 = "this is not base64!@#$%^&*()";
  const result = checkFiles([
    { name: "photo.jpg", type: "image/jpeg", data: corruptBase64 }
  ]);

  assert.ok(result.error);
  assert.match(result.error, /could not be read/);
});

test("FileIntakeValidator: enforces media size limits (single & total)", () => {
  const customValidator = new FileIntakeValidator({
    maxSingleMediaBase64: 100,
    maxTotalMediaBase64: 150
  });

  const b64_80 = "A".repeat(80);
  const b64_120 = "A".repeat(120);

  // Single file exceeds 100
  const overSingle = customValidator.validate([{ name: "img.png", type: "image/png", data: b64_120 }]);
  assert.ok(overSingle.error);
  assert.match(overSingle.error, /too large/);

  // Two files of 80 (total 160 > 150)
  const overTotal = customValidator.validate([
    { name: "img1.png", type: "image/png", data: b64_80 },
    { name: "img2.png", type: "image/png", data: b64_80 }
  ]);
  assert.ok(overTotal.error);
  assert.match(overTotal.error, /too large/);
});

test("FileIntakeValidator: accepts allowed text files and tracks character budget", () => {
  const result = checkFiles([
    { name: "notes.md", type: "text/markdown", text: "# Header\nHello world" },
    { name: "data.csv", type: "text/csv", text: "col1,col2\n1,2" },
    { name: "config.json", type: "application/json", text: '{"key":"value"}' }
  ]);

  assert.equal(result.error, null);
  assert.equal(result.files.length, 3);
  assert.equal(result.stats.textCount, 3);
  assert.equal(result.stats.mediaCount, 0);
  assert.ok(result.stats.totalTextChars > 0);
});

test("FileIntakeValidator: enforces text character limits (single & total)", () => {
  const customValidator = new FileIntakeValidator({
    maxSingleTextChars: 50,
    maxTotalTextChars: 80
  });

  // Single exceeds 50
  const overSingle = customValidator.validate([{ name: "t.txt", type: "text/plain", text: "x".repeat(60) }]);
  assert.ok(overSingle.error);
  assert.match(overSingle.error, /must be under 50 characters/);

  // Total exceeds 80
  const overTotal = customValidator.validate([
    { name: "t1.txt", type: "text/plain", text: "x".repeat(45) },
    { name: "t2.txt", type: "text/plain", text: "x".repeat(45) }
  ]);
  assert.ok(overTotal.error);
  assert.match(overTotal.error, /Combined text attachments are too large/);
});

test("FileIntakeValidator: imageOnly mode accepts images and rejects PDFs/text", () => {
  const validBase64 = Buffer.from("image data").toString("base64");

  // Valid image passes
  const imgPass = checkFiles([{ name: "pic.png", type: "image/png", data: validBase64 }], true);
  assert.equal(imgPass.error, null);
  assert.equal(imgPass.files.length, 1);

  // PDF fails in imageOnly mode
  const pdfFail = checkFiles([{ name: "paper.pdf", type: "application/pdf", data: validBase64 }], true);
  assert.ok(pdfFail.error);
  assert.match(pdfFail.error, /accepts image attachments only/);

  // Text file fails in imageOnly mode
  const textFail = checkFiles([{ name: "prompt.txt", type: "text/plain", text: "draw a cat" }], true);
  assert.ok(textFail.error);
  assert.match(textFail.error, /accepts image attachments only/);
});
