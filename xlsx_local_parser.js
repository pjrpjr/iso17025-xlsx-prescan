(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.XLSXLocalParser = factory();
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function decodeXmlEntities(str) {
    return String(str || "")
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, hex) {
        return String.fromCharCode(parseInt(hex, 16));
      })
      .replace(/&#(\d+);/g, function (_, dec) {
        return String.fromCharCode(parseInt(dec, 10));
      })
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function MinimalXmlElement(tagName, attrs) {
    this.tagName = tagName;
    this.localName = tagName.indexOf(":") !== -1 ? tagName.split(":").pop() : tagName;
    this.attributes = attrs || {};
    this.children = [];
    this.textBuffer = [];
  }

  MinimalXmlElement.prototype.getAttribute = function (name) {
    if (Object.prototype.hasOwnProperty.call(this.attributes, name)) {
      return this.attributes[name];
    }
    return null;
  };

  MinimalXmlElement.prototype.getAttributeNames = function () {
    return Object.keys(this.attributes);
  };

  Object.defineProperty(MinimalXmlElement.prototype, "textContent", {
    get: function () {
      var out = [];
      for (var i = 0; i < this.textBuffer.length; i++) {
        out.push(this.textBuffer[i]);
      }
      for (var j = 0; j < this.children.length; j++) {
        out.push(this.children[j].textContent);
      }
      return out.join("");
    }
  });

  MinimalXmlElement.prototype.getElementsByTagName = function (target) {
    var results = [];
    var wantAll = target === "*";
    function walk(node) {
      for (var i = 0; i < node.children.length; i++) {
        var child = node.children[i];
        if (wantAll || child.tagName === target || child.localName === target) {
          results.push(child);
        }
        walk(child);
      }
    }
    walk(this);
    return results;
  };

  function parseXmlFallback(xmlText) {
    var root = new MinimalXmlElement("#document", {});
    var stack = [root];
    var clean = String(xmlText || "").replace(/^\uFEFF/, "");
    var tokenRe = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
    var attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    var match;
    while ((match = tokenRe.exec(clean)) !== null) {
      if (match[1] !== undefined) {
        stack[stack.length - 1].textBuffer.push(match[1]);
      } else if (match[6] !== undefined) {
        stack[stack.length - 1].textBuffer.push(decodeXmlEntities(match[6]));
      } else if (match[3] !== undefined) {
        var isClose = match[2] === "/";
        var tag = match[3];
        var attrChunk = match[4] || "";
        var selfClose = match[5] === "/";
        if (isClose) {
          if (stack.length > 1) {
            stack.pop();
          }
        } else {
          var attrs = {};
          attrRe.lastIndex = 0;
          var am;
          while ((am = attrRe.exec(attrChunk)) !== null) {
            attrs[am[1]] = decodeXmlEntities(am[2] !== undefined ? am[2] : am[3]);
          }
          var el = new MinimalXmlElement(tag, attrs);
          stack[stack.length - 1].children.push(el);
          if (!selfClose) {
            stack.push(el);
          }
        }
      }
    }
    return root;
  }

  function parseXml(xmlText) {
    if (typeof DOMParser !== "undefined") {
      return new DOMParser().parseFromString(xmlText, "text/xml");
    }
    return parseXmlFallback(xmlText);
  }

  function findElements(rootNode, tagName) {
    if (!rootNode || typeof rootNode.getElementsByTagName !== "function") {
      return [];
    }
    var direct = rootNode.getElementsByTagName(tagName);
    if (direct && direct.length > 0) {
      return Array.prototype.slice.call(direct);
    }
    var all = rootNode.getElementsByTagName("*");
    var matched = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var ln = el.localName || (el.tagName ? el.tagName.split(":").pop() : "");
      if (ln === tagName) {
        matched.push(el);
      }
    }
    return matched;
  }

  function getAttrCI(el, targetName, fallbackVal) {
    if (!el || typeof el.getAttribute !== "function") {
      return fallbackVal;
    }
    var direct = el.getAttribute(targetName);
    if (direct !== null && direct !== undefined) {
      return direct;
    }
    var want = targetName.toLowerCase();
    if (typeof el.getAttributeNames === "function") {
      var names = el.getAttributeNames();
      for (var i = 0; i < names.length; i++) {
        var nm = names[i];
        var local = nm.indexOf(":") !== -1 ? nm.split(":").pop() : nm;
        if (local.toLowerCase() === want) {
          return el.getAttribute(nm);
        }
      }
    } else if (el.attributes) {
      for (var j = 0; j < el.attributes.length; j++) {
        var attr = el.attributes[j];
        var lname = attr.name.indexOf(":") !== -1 ? attr.name.split(":").pop() : attr.name;
        if (lname.toLowerCase() === want) {
          return attr.value;
        }
      }
    }
    return fallbackVal;
  }

  function decodeBase64ToUint8Array(base64Str) {
    var clean = String(base64Str || "").replace(/\s+/g, "");
    if (typeof atob === "function") {
      var bin = atob(clean);
      var out = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
      }
      return out;
    }
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(clean, "base64"));
    }
    throw new Error("No base64 decoder available");
  }

  async function decompressEntry(compressedBytes, method) {
    if (method === 0) {
      return compressedBytes;
    }
    if (method === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("Native DecompressionStream('deflate-raw') is not available in this environment.");
      }
      var ds = new DecompressionStream("deflate-raw");
      var writer = ds.writable.getWriter();
      writer.write(compressedBytes);
      writer.close();
      var reader = ds.readable.getReader();
      var chunks = [];
      var totalLen = 0;
      while (true) {
        var step = await reader.read();
        if (step.done) {
          break;
        }
        if (step.value) {
          chunks.push(step.value);
          totalLen += step.value.length;
        }
      }
      var merged = new Uint8Array(totalLen);
      var offset = 0;
      for (var i = 0; i < chunks.length; i++) {
        merged.set(chunks[i], offset);
        offset += chunks[i].length;
      }
      return merged;
    }
    throw new Error("Unsupported ZIP compression method: " + method);
  }

  async function readZipArchive(arrayBuffer) {
    var bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var decoder = new TextDecoder("utf-8");

    var minOffset = Math.max(0, bytes.length - 65557);
    var eocdOffset = -1;
    for (var pos = bytes.length - 22; pos >= minOffset; pos--) {
      if (view.getUint32(pos, true) === 0x06054b50) {
        eocdOffset = pos;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error("Invalid .xlsx/.xlsm ZIP archive: EOCD header not found.");
    }

    var entryCount = view.getUint16(eocdOffset + 10, true);
    var cdOffset = view.getUint32(eocdOffset + 16, true);
    var entries = {};
    var cursor = cdOffset;

    for (var i = 0; i < entryCount; i++) {
      if (view.getUint32(cursor, true) !== 0x02014b50) {
        throw new Error("Corrupt ZIP central directory entry at offset " + cursor);
      }
      var method = view.getUint16(cursor + 10, true);
      var compressedSize = view.getUint32(cursor + 20, true);
      var nameLen = view.getUint16(cursor + 28, true);
      var extraLen = view.getUint16(cursor + 30, true);
      var commentLen = view.getUint16(cursor + 32, true);
      var localHeaderOffset = view.getUint32(cursor + 42, true);

      var nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
      var fileName = decoder.decode(nameBytes);
      cursor += 46 + nameLen + extraLen + commentLen;

      if (view.getUint32(localHeaderOffset, true) !== 0x04034b50) {
        throw new Error("Invalid ZIP local header for " + fileName);
      }
      var lhNameLen = view.getUint16(localHeaderOffset + 26, true);
      var lhExtraLen = view.getUint16(localHeaderOffset + 28, true);
      var dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
      var rawSlice = bytes.subarray(dataStart, dataStart + compressedSize);

      entries[fileName] = {
        name: fileName,
        method: method,
        compressedBytes: rawSlice
      };
    }

    return {
      names: Object.keys(entries),
      readBytes: async function (name) {
        var entry = entries[name];
        if (!entry) {
          return null;
        }
        return decompressEntry(entry.compressedBytes, entry.method);
      },
      readText: async function (name) {
        var raw = await this.readBytes(name);
        if (!raw) {
          return null;
        }
        return decoder.decode(raw);
      }
    };
  }

  function resolveZipTarget(baseDir, target) {
    var clean = String(target || "").replace(/\\/g, "/").replace(/^\/+/, "");
    if (clean.indexOf("xl/") === 0) {
      return clean;
    }
    var parts = baseDir.split("/").filter(Boolean).concat(clean.split("/"));
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p || p === ".") {
        continue;
      }
      if (p === "..") {
        if (out.length > 0) {
          out.pop();
        }
      } else {
        out.push(p);
      }
    }
    return out.join("/");
  }

  function colLetterToIdx(ref) {
    var m = /^\$?([A-Za-z]+)/.exec(ref || "");
    if (!m) {
      return 0;
    }
    var letters = m[1].toUpperCase();
    var idx = 0;
    for (var i = 0; i < letters.length; i++) {
      idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx - 1;
  }

  function parseSharedStrings(xmlText) {
    if (!xmlText) {
      return [];
    }
    var doc = parseXml(xmlText);
    var siNodes = findElements(doc, "si");
    var strings = [];
    for (var i = 0; i < siNodes.length; i++) {
      var tNodes = findElements(siNodes[i], "t");
      if (tNodes.length > 0) {
        var buf = [];
        for (var j = 0; j < tNodes.length; j++) {
          buf.push(tNodes[j].textContent || "");
        }
        strings.push(buf.join(""));
      } else {
        strings.push(siNodes[i].textContent || "");
      }
    }
    return strings;
  }

  function parseUnlockedStyleIndices(xmlText) {
    var unlocked = {};
    if (!xmlText) {
      return unlocked;
    }
    var doc = parseXml(xmlText);
    var cellXfsList = findElements(doc, "cellXfs");
    if (cellXfsList.length === 0) {
      return unlocked;
    }
    var xfs = findElements(cellXfsList[0], "xf");
    for (var i = 0; i < xfs.length; i++) {
      var prots = findElements(xfs[i], "protection");
      for (var j = 0; j < prots.length; j++) {
        var lockedVal = getAttrCI(prots[j], "locked", "1");
        if (lockedVal === "0" || String(lockedVal).toLowerCase() === "false") {
          unlocked[i] = true;
        }
      }
    }
    return unlocked;
  }

  async function parseXlsxArrayBuffer(arrayBuffer, filename) {
    var zip = await readZipArchive(arrayBuffer);
    var names = zip.names.slice().sort();

    var ssXml = await zip.readText("xl/sharedStrings.xml");
    var sharedStrings = parseSharedStrings(ssXml);

    var stylesXml = await zip.readText("xl/styles.xml");
    var unlockedXfs = parseUnlockedStyleIndices(stylesXml);

    var externalLinks = names.filter(function (n) {
      return n.indexOf("xl/externalLinks/") === 0 && n.slice(-1) !== "/";
    });
    var vbaBins = names.filter(function (n) {
      var low = n.toLowerCase();
      return low === "xl/vbaproject.bin" || low === "xl/vbaprojectsignature.bin";
    });

    var relsMap = {};
    var wbRelsXml = await zip.readText("xl/_rels/workbook.xml.rels");
    if (wbRelsXml) {
      var relsDoc = parseXml(wbRelsXml);
      var relNodes = findElements(relsDoc, "Relationship");
      for (var r = 0; r < relNodes.length; r++) {
        var rid = getAttrCI(relNodes[r], "Id", "");
        var target = getAttrCI(relNodes[r], "Target", "");
        if (rid && target) {
          relsMap[rid] = resolveZipTarget("xl", target);
        }
      }
    }

    var sheetsMeta = [];
    var wbXml = await zip.readText("xl/workbook.xml");
    if (wbXml) {
      var wbDoc = parseXml(wbXml);
      var sheetNodes = findElements(wbDoc, "sheet");
      for (var s = 0; s < sheetNodes.length; s++) {
        var sname = getAttrCI(sheetNodes[s], "name", "Sheet" + (s + 1));
        var srid = getAttrCI(sheetNodes[s], "r:id", "") || getAttrCI(sheetNodes[s], "id", "");
        if (srid && relsMap[srid]) {
          sheetsMeta.push({ name: sname, path: relsMap[srid] });
        }
      }
    }

    if (sheetsMeta.length === 0) {
      var wsNames = names.filter(function (n) {
        return /^xl\/worksheets\/sheet\d+\.xml$/i.test(n);
      });
      for (var w = 0; w < wsNames.length; w++) {
        sheetsMeta.push({ name: "Sheet" + (w + 1), path: wsNames[w] });
      }
    }

    var sheets = [];
    for (var si = 0; si < sheetsMeta.length; si++) {
      var meta = sheetsMeta[si];
      var wsXml = await zip.readText(meta.path);
      if (!wsXml) {
        continue;
      }
      var wsDoc = parseXml(wsXml);

      var protNodes = findElements(wsDoc, "sheetProtection");
      var hasSheetProtection = false;
      for (var p = 0; p < protNodes.length; p++) {
        var sheetFlag = getAttrCI(protNodes[p], "sheet", "1");
        if (sheetFlag !== "0" && String(sheetFlag).toLowerCase() !== "false") {
          hasSheetProtection = true;
          break;
        }
      }

      var formulaCells = [];
      var rowsCells = [];
      var allTextCells = [];
      var rowNodes = findElements(wsDoc, "row");

      for (var ri = 0; ri < rowNodes.length; ri++) {
        var rowEl = rowNodes[ri];
        var cellNodes = findElements(rowEl, "c");
        var rowVals = [];

        for (var ci = 0; ci < cellNodes.length; ci++) {
          var cellEl = cellNodes[ci];
          var ref = getAttrCI(cellEl, "r", "A" + (ri + 1));
          var ctype = getAttrCI(cellEl, "t", "");
          var styleRaw = getAttrCI(cellEl, "s", "");
          var styleIdx = /^\d+$/.test(String(styleRaw)) ? parseInt(styleRaw, 10) : -1;

          var fNodes = findElements(cellEl, "f");
          var vNodes = findElements(cellEl, "v");
          var isNodes = findElements(cellEl, "is");

          var formulaStr = fNodes.length > 0 ? String(fNodes[0].textContent || "").trim() : "";
          var valRaw = vNodes.length > 0 ? String(vNodes[0].textContent || "").trim() : "";
          var inlineStr = "";
          if (isNodes.length > 0) {
            var itNodes = findElements(isNodes[0], "t");
            if (itNodes.length > 0) {
              inlineStr = itNodes.map(function (n) { return n.textContent || ""; }).join("").trim();
            } else {
              inlineStr = String(isNodes[0].textContent || "").trim();
            }
          }

          var resolvedVal = "";
          if (ctype === "s" && /^\d+$/.test(valRaw)) {
            var ssIdx = parseInt(valRaw, 10);
            resolvedVal = ssIdx >= 0 && ssIdx < sharedStrings.length ? sharedStrings[ssIdx] : valRaw;
          } else if (ctype === "inlineStr") {
            resolvedVal = inlineStr;
          } else {
            resolvedVal = valRaw || inlineStr;
          }

          var colIdx = colLetterToIdx(ref);
          if (resolvedVal) {
            allTextCells.push({ ref: ref, text: resolvedVal });
            rowVals.push({ col: colIdx, val: resolvedVal });
          }
          if (formulaStr) {
            allTextCells.push({ ref: ref, text: formulaStr });
            formulaCells.push({
              ref: ref,
              formula: formulaStr,
              cached_value: resolvedVal,
              cell_type: ctype,
              unlocked: Boolean(unlockedXfs[styleIdx])
            });
          }
        }

        if (rowVals.length > 0) {
          rowsCells.push(rowVals);
        }
      }

      sheets.push({
        name: meta.name,
        path: meta.path,
        has_sheet_protection: hasSheetProtection,
        formula_cells: formulaCells,
        rows_cells: rowsCells,
        all_text_cells: allTextCells
      });
    }

    return {
      filename: filename || "workbook.xlsx",
      shared_strings: sharedStrings,
      external_links: externalLinks,
      vba_bins: vbaBins,
      sheets: sheets
    };
  }

  return {
    parseXml: parseXml,
    decodeBase64ToUint8Array: decodeBase64ToUint8Array,
    parseXlsxArrayBuffer: parseXlsxArrayBuffer
  };
}));
