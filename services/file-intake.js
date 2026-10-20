"use strict";

const MAX_FILES = 4;
const MAX_FILE_NAME_LENGTH = 160;
const MAX_SINGLE_MEDIA_BASE64 = 5_600_000;
const MAX_TOTAL_MEDIA_BASE64 = 9_000_000;
const MAX_SINGLE_TEXT_CHARS = 250_000;
const MAX_TOTAL_TEXT_CHARS = 400_000;

const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf"
]);

const ALLOWED_IMAGE_ONLY = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/heic",
  "image/heif"
]);

const ALLOWED_TEXT = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json"
]);

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

class FileIntakeValidator {
  constructor(options = {}) {
    this.maxFiles = options.maxFiles || MAX_FILES;
    this.maxFileNameLength = options.maxFileNameLength || MAX_FILE_NAME_LENGTH;
    this.maxSingleMediaBase64 = options.maxSingleMediaBase64 || MAX_SINGLE_MEDIA_BASE64;
    this.maxTotalMediaBase64 = options.maxTotalMediaBase64 || MAX_TOTAL_MEDIA_BASE64;
    this.maxSingleTextChars = options.maxSingleTextChars || MAX_SINGLE_TEXT_CHARS;
    this.maxTotalTextChars = options.maxTotalTextChars || MAX_TOTAL_TEXT_CHARS;
    this.allowedMedia = options.allowedMedia || ALLOWED_MEDIA;
    this.allowedText = options.allowedText || ALLOWED_TEXT;
  }

  isMedia(type) {
    return Boolean(type && this.allowedMedia.has(String(type).toLowerCase()));
  }

  isText(type) {
    return Boolean(type && this.allowedText.has(String(type).toLowerCase()));
  }

  isImage(type) {
    const t = String(type || "").toLowerCase();
    return ALLOWED_IMAGE_ONLY.has(t);
  }

  validate(raw, { imageOnly = false } = {}) {
    if (raw == null) {
      return {
        files: [],
        error: null,
        stats: { mediaCount: 0, textCount: 0, totalMediaBase64: 0, totalTextChars: 0 }
      };
    }

    if (!Array.isArray(raw) || raw.length > this.maxFiles) {
      return {
        files: [],
        error: `Attach up to ${this.maxFiles} files per message.`,
        stats: null
      };
    }

    const files = [];
    let totalMediaBase64 = 0;
    let totalTextChars = 0;
    let mediaCount = 0;
    let textCount = 0;

    for (const f of raw) {
      if (!f || typeof f !== "object") {
        return { files: [], error: "One of the attachments is invalid.", stats: null };
      }

      if (typeof f.name !== "string" || !f.name.trim() || f.name.length > this.maxFileNameLength) {
        return { files: [], error: "Attachment name is missing or exceeds maximum length.", stats: null };
      }

      if (typeof f.type !== "string") {
        return { files: [], error: "Attachment MIME type is missing or invalid.", stats: null };
      }

      const type = f.type.toLowerCase().trim();

      if (imageOnly && !this.isImage(type)) {
        return { files: [], error: "Image generation accepts image attachments only.", stats: null };
      }

      if (this.isMedia(type)) {
        if (typeof f.data !== "string" || !f.data.length || !BASE64_REGEX.test(f.data)) {
          return { files: [], error: `Media attachment "${f.name}" could not be read. Remove it and try again.`, stats: null };
        }

        totalMediaBase64 += f.data.length;
        if (f.data.length > this.maxSingleMediaBase64 || totalMediaBase64 > this.maxTotalMediaBase64) {
          return {
            files: [],
            error: "Attachments are too large. Keep each file under 4 MB and the total under about 6 MB.",
            stats: null
          };
        }

        mediaCount++;
        files.push({ name: f.name.trim(), type, data: f.data });
        continue;
      }

      if (!imageOnly && this.isText(type)) {
        if (typeof f.text !== "string" || f.text.length > this.maxSingleTextChars) {
          return {
            files: [],
            error: `Text file "${f.name}" must be under ${this.maxSingleTextChars.toLocaleString()} characters.`,
            stats: null
          };
        }

        totalTextChars += f.text.length;
        if (totalTextChars > this.maxTotalTextChars) {
          return { files: [], error: "Combined text attachments are too large.", stats: null };
        }

        textCount++;
        files.push({ name: f.name.trim(), type, text: f.text });
        continue;
      }

      return {
        files: [],
        error: imageOnly
          ? "Use a PNG, JPG, or WebP image to create or edit an image."
          : `File type "${type}" is not supported. Use an image, PDF, TXT, Markdown, CSV, or JSON file.`,
        stats: null
      };
    }

    return {
      files,
      error: null,
      stats: {
        mediaCount,
        textCount,
        totalMediaBase64,
        totalTextChars
      }
    };
  }
}

const defaultValidator = new FileIntakeValidator();

function checkFiles(raw, imageOnly = false) {
  return defaultValidator.validate(raw, { imageOnly });
}

module.exports = {
  FileIntakeValidator,
  checkFiles,
  defaultValidator,
  MAX_FILES,
  MAX_FILE_NAME_LENGTH,
  MAX_SINGLE_MEDIA_BASE64,
  MAX_TOTAL_MEDIA_BASE64,
  MAX_SINGLE_TEXT_CHARS,
  MAX_TOTAL_TEXT_CHARS,
  ALLOWED_MEDIA,
  ALLOWED_IMAGE_ONLY,
  ALLOWED_TEXT
};
