(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.ZeroUploadCSV = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function fnv1aHex(str) {
    var h = 0x811c9dc5;
    var text = String(str || "");
    var bytes = typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(text)
      : Buffer.from(text, "utf8");
    for (var i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
  }

  function parseCSV(text, filename) {
    var clean = String(text || "").replace(/^\uFEFF/, "");
    var rows = [];
    var currentRow = [];
    var currentField = "";
    var inQuotes = false;

    for (var i = 0; i < clean.length; i++) {
      var ch = clean.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < clean.length && clean.charAt(i + 1) === '"') {
            currentField += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          currentField += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        currentRow.push(currentField.trim());
        currentField = "";
      } else if (ch === "\r" || ch === "\n") {
        if (ch === "\r" && i + 1 < clean.length && clean.charAt(i + 1) === "\n") {
          i += 1;
        }
        currentRow.push(currentField.trim());
        if (currentRow.some(function (cell) { return cell !== ""; })) {
          rows.push(currentRow);
        }
        currentRow = [];
        currentField = "";
      } else {
        currentField += ch;
      }
    }
    if (currentField.length > 0 || currentRow.length > 0) {
      currentRow.push(currentField.trim());
      if (currentRow.some(function (cell) { return cell !== ""; })) {
        rows.push(currentRow);
      }
    }

    if (rows.length === 0) {
      return { filename: filename || "instrument.csv", headers: [], rows: [] };
    }

    var headers = rows[0].map(function (h) { return String(h || "").trim(); });
    var records = [];
    for (var r = 1; r < rows.length; r++) {
      var raw = rows[r];
      var obj = { __source_row: r + 1 };
      for (var c = 0; c < headers.length; c++) {
        obj[headers[c]] = c < raw.length ? raw[c] : "";
      }
      records.push(obj);
    }

    return {
      filename: filename || "instrument.csv",
      headers: headers,
      rows: records
    };
  }

  return {
    fnv1aHex: fnv1aHex,
    parseCSV: parseCSV
  };
}));
