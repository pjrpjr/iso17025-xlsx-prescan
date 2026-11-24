(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(
      require("./csv_parser.js"),
      require("./xlsx_local_parser.js")
    );
  } else {
    root.PRESCAN_ENGINE = factory(root.ZeroUploadCSV, root.XLSXLocalParser);
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (CSV, XLSXParser) {
  "use strict";

  var PACKAGE_MIN_WORKBOOKS = 5;
  var PACKAGE_MAX_WORKBOOKS = 8;
  var PACKAGE_MAX_CSVS = 50;
  var FIXED_FEE_CENTS = 149500;
  var AVOIDED_REASSESSMENT_LOW_CENTS = 400000;
  var AVOIDED_REASSESSMENT_HIGH_CENTS = 1200000;
  var QA_HOURS_SAVED_LOW = 40;
  var QA_HOURS_SAVED_HIGH = 80;

  var ALL_RULE_IDS = [
    "C7112-PROT-01",
    "C7112-PROT-02",
    "C7112-MAGIC-01",
    "C7112-DIV-01",
    "C7112-VOL-01",
    "C7112-ERR-01",
    "C7112-EXT-01",
    "C7112-VBA-01",
    "C64-EQUIP-01",
    "C64-EXP-01",
    "C64-REG-01",
    "C75-OPER-01",
    "C75-ENV-01"
  ];

  var SHIELD_PATTERNS = [
    { token: "ITAR", re: /\bITAR\b/i },
    { token: "EAR", re: /\bEAR(?:99)?\b/i },
    { token: "AMS2750", re: /\bAMS[\s\-_]*2750\b/i },
    { token: "NADCAP", re: /\bNADCAP\b/i },
    { token: "CUI", re: /\bCUI\b/i },
    { token: "DOD", re: /\b(?:DOD|DFARS)\b/i },
    { token: "PATIENT_NAME", re: /\bPATIENT[\s_]*NAME\b/i },
    { token: "MRN", re: /\bMRN\b/i },
    { token: "SSN_TOKEN", re: /\bSSN\b/i },
    { token: "SSN_PATTERN", re: /\b\d{3}-\d{2}-\d{4}\b/ }
  ];

  var VOLATILE_FUNC_RE = /\b(INDIRECT|OFFSET|NOW|TODAY|RAND|RANDBETWEEN)\s*\(/i;
  var FORMULA_ERROR_RE = /(?:#REF!|#DIV\/0!|#NAME\?|#VALUE!|#N\/A|#NUM!)/;
  var EXTERNAL_FORMULA_REF_RE = /\[[^\]]+\.(?:xlsx|xlsm|xls|xlsb)\]|\[[0-9]+\]!/i;
  var QUOTED_STR_RE = /"(?:""|[^"])*"/g;
  var SHEET_CELL_REF_RE = /(?:(?:'[^']+'|[A-Za-z0-9_.\-]+)!)?\$?[A-Z]{1,3}\$?\d+/gi;
  var BENIGN_STRUCTURAL_INTS = { "0": true, "1": true, "2": true, "3": true, "4": true, "10": true, "100": true, "1000": true };

  var CSV_COLUMN_ALIASES = {
    equipment_id: ["equipment_id", "equip_id", "instrument_id", "asset_id", "device_id", "meter_id"],
    test_date: ["test_date", "run_date", "measurement_date", "sample_date", "analysis_date", "date"],
    cal_due_date: ["cal_due_date", "calibration_due_date", "calibration_due", "due_date", "next_cal_due", "cal_expiry"],
    operator_id: ["operator_id", "analyst_id", "tech_id", "technician_id", "operator", "analyst"],
    temp_c: ["temp_c", "temperature_c", "ambient_temp_c", "lab_temp_c", "temp"],
    humidity_pct: ["humidity_pct", "rh_pct", "relative_humidity", "humidity", "rh"],
    sample_id: ["sample_id", "specimen_id", "run_id", "batch_id", "record_id"]
  };

  function normalizeHeader(raw) {
    return String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  }

  function scanShieldText(text, source, location) {
    if (!text) {
      return [];
    }
    var hits = [];
    var seen = {};
    for (var i = 0; i < SHIELD_PATTERNS.length; i++) {
      var spec = SHIELD_PATTERNS[i];
      if (spec.re.test(text) && !seen[spec.token]) {
        seen[spec.token] = true;
        hits.push({
          source: source,
          location: location,
          token: spec.token,
          detail: "Prohibited marker (" + spec.token + ") detected in " + source + " at " + location + "."
        });
      }
    }
    return hits;
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function parseDateKey(raw) {
    if (raw === null || raw === undefined) {
      return null;
    }
    var s = String(raw).trim();
    if (!s) {
      return null;
    }
    if (/^\d{5}(?:\.\d+)?$/.test(s)) {
      var serial = Math.floor(parseFloat(s));
      if (serial >= 20000 && serial <= 80000) {
        var baseMs = Date.UTC(1899, 11, 30);
        var dt = new Date(baseMs + serial * 86400000);
        return dt.getUTCFullYear() + "-" + pad2(dt.getUTCMonth() + 1) + "-" + pad2(dt.getUTCDate());
      }
    }
    var isoM = /^(\d{4})[-\/](\d{2})[-\/](\d{2})/.exec(s);
    if (isoM) {
      var y = parseInt(isoM[1], 10);
      var m = parseInt(isoM[2], 10);
      var d = parseInt(isoM[3], 10);
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
        return isoM[1] + "-" + isoM[2] + "-" + isoM[3];
      }
    }
    var usM = /^(\d{2})[-\/](\d{2})[-\/](\d{4})/.exec(s);
    if (usM) {
      var um = parseInt(usM[1], 10);
      var ud = parseInt(usM[2], 10);
      if (um >= 1 && um <= 12 && ud >= 1 && ud <= 31) {
        return usM[3] + "-" + usM[1] + "-" + usM[2];
      }
    }
    return null;
  }

  function isNumericValue(raw) {
    var s = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!s) {
      return false;
    }
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s);
  }

  function analyzeFormulaText(formula) {
    var raw = String(formula || "").trim();
    var noQuotes = raw.replace(QUOTED_STR_RE, '""');
    var noRefs = noQuotes.replace(SHEET_CELL_REF_RE, " REF ");

    var hasExternalRef = EXTERNAL_FORMULA_REF_RE.test(noQuotes);
    var volMatch = VOLATILE_FUNC_RE.exec(noQuotes);
    var hasVolatile = Boolean(volMatch);
    var volatileName = volMatch ? volMatch[1].toUpperCase() : "";

    var errMatch = FORMULA_ERROR_RE.exec(raw);
    var hasErrorToken = Boolean(errMatch);
    var errorToken = errMatch ? errMatch[0] : "";

    var hasUnguardedDiv = noQuotes.indexOf("/") !== -1 && noQuotes.toUpperCase().indexOf("IFERROR(") === -1;

    var magicConstants = [];
    var numRe = /\b(\d+(?:\.\d+)?)\b/g;
    var nm;
    while ((nm = numRe.exec(noRefs)) !== null) {
      var idx = nm.index;
      var prevCh = idx > 0 ? noRefs.charAt(idx - 1) : "";
      var nextCh = idx + nm[0].length < noRefs.length ? noRefs.charAt(idx + nm[0].length) : "";
      if (/[A-Za-z0-9_$]/.test(prevCh) || /[A-Za-z0-9_]/.test(nextCh)) {
        continue;
      }
      var lit = nm[1];
      if (lit.indexOf(".") !== -1 || !BENIGN_STRUCTURAL_INTS[lit]) {
        magicConstants.push(lit);
      }
    }

    return {
      has_external_ref: hasExternalRef,
      has_volatile: hasVolatile,
      volatile_name: volatileName,
      has_error_token: hasErrorToken,
      error_token: errorToken,
      has_unguarded_div: hasUnguardedDiv,
      magic_constants: magicConstants
    };
  }

  function buildCsvColumnMap(headers) {
    var normToOrig = {};
    for (var i = 0; i < headers.length; i++) {
      var nh = normalizeHeader(headers[i]);
      if (nh && !Object.prototype.hasOwnProperty.call(normToOrig, nh)) {
        normToOrig[nh] = headers[i];
      }
    }
    var colMap = {};
    var keys = Object.keys(CSV_COLUMN_ALIASES);
    for (var k = 0; k < keys.length; k++) {
      var canonical = keys[k];
      var aliases = CSV_COLUMN_ALIASES[canonical];
      for (var a = 0; a < aliases.length; a++) {
        if (Object.prototype.hasOwnProperty.call(normToOrig, aliases[a])) {
          colMap[canonical] = normToOrig[aliases[a]];
          break;
        }
      }
    }
    return colMap;
  }

  function isRegisterCsv(filename, colMap) {
    var fname = String(filename || "").toLowerCase();
    if (fname.indexOf("register") !== -1 || fname.indexOf("cal_master") !== -1) {
      return true;
    }
    var hasEquipAndDue = Boolean(colMap.equipment_id) && Boolean(colMap.cal_due_date);
    var hasMeasureCols = Boolean(colMap.test_date) || Boolean(colMap.temp_c) || Boolean(colMap.operator_id);
    return hasEquipAndDue && !hasMeasureCols;
  }

  function rowsCellsToRecords(rowsCells) {
    if (!rowsCells || rowsCells.length < 2) {
      return { headers: [], records: [] };
    }
    var maxCol = 0;
    for (var r = 0; r < rowsCells.length; r++) {
      for (var c = 0; c < rowsCells[r].length; c++) {
        if (rowsCells[r][c].col > maxCol) {
          maxCol = rowsCells[r][c].col;
        }
      }
    }
    var headerRow = new Array(maxCol + 1).fill("");
    for (var h = 0; h < rowsCells[0].length; h++) {
      headerRow[rowsCells[0][h].col] = String(rowsCells[0][h].val || "").trim();
    }
    var headers = headerRow.map(function (hv, idx) { return hv || ("col_" + idx); });
    var records = [];
    for (var ri = 1; ri < rowsCells.length; ri++) {
      var vals = new Array(maxCol + 1).fill("");
      for (var ci = 0; ci < rowsCells[ri].length; ci++) {
        vals[rowsCells[ri][ci].col] = String(rowsCells[ri][ci].val || "").trim();
      }
      var rec = {};
      var anyNonEmpty = false;
      for (var k = 0; k < headers.length; k++) {
        rec[headers[k]] = vals[k];
        if (vals[k]) {
          anyNonEmpty = true;
        }
      }
      if (anyNonEmpty) {
        records.push(rec);
      }
    }
    return { headers: headers, records: records };
  }

  function buildTestVectorsForFormula(workbook, sheet, cell, formula, cellDefects) {
    var defectSet = {};
    for (var i = 0; i < cellDefects.length; i++) {
      defectSet[cellDefects[i]] = true;
    }
    var hasDiv = Boolean(defectSet["C7112-DIV-01"]);
    var hasMagic = Boolean(defectSet["C7112-MAGIC-01"]);
    var hasVolOrExt = Boolean(defectSet["C7112-VOL-01"] || defectSet["C7112-EXT-01"] || defectSet["C7112-ERR-01"]);
    var hasProt = Boolean(defectSet["C7112-PROT-01"] || defectSet["C7112-PROT-02"]);

    var specs = [
      {
        vector_case: "NOMINAL",
        input_summary: "Nominal in-range lab measurement & reference factor",
        expected_behavior: "Finite deterministic output traceable to URS specification",
        status: (hasMagic || hasVolOrExt || hasProt) ? "AT_RISK" : "PASS_READY"
      },
      {
        vector_case: "ZERO",
        input_summary: "Zero denominator / blank reading boundary (x = 0)",
        expected_behavior: "Graceful IFERROR fallback without #DIV/0! propagation",
        status: (hasDiv || hasVolOrExt) ? "AT_RISK" : "PASS_READY"
      },
      {
        vector_case: "NEGATIVE",
        input_summary: "Negative blank-corrected input (x = -1.0)",
        expected_behavior: "Expected domain handling / negative sign flag per method SOP",
        status: (hasMagic || hasVolOrExt) ? "AT_RISK" : "PASS_READY"
      },
      {
        vector_case: "UPPER_BOUND",
        input_summary: "Upper calibrated instrument span (x = 1,000,000)",
        expected_behavior: "No overflow, truncation, or unguarded constant scaling drift",
        status: (hasMagic || hasVolOrExt) ? "AT_RISK" : "PASS_READY"
      },
      {
        vector_case: "SIG_FIG_ROUNDING",
        input_summary: "Half-up vs round-half-even boundary (1.005 / 0.1255)",
        expected_behavior: "Explicit ROUND() / sig-fig alignment matching certified method",
        status: (hasMagic || formula.toUpperCase().indexOf("ROUND(") === -1) ? "AT_RISK" : "PASS_READY"
      }
    ];

    return specs.map(function (sp) {
      return {
        workbook: workbook,
        sheet: sheet,
        cell: cell,
        formula: formula,
        vector_case: sp.vector_case,
        input_summary: sp.input_summary,
        expected_behavior: sp.expected_behavior,
        status: sp.status
      };
    });
  }

  function sortedStringify(obj) {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
      return "[" + obj.map(sortedStringify).join(",") + "]";
    }
    var keys = Object.keys(obj).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + sortedStringify(obj[k]);
    }).join(",") + "}";
  }

  async function evaluateBundle(input) {
    var workbooksInput = (input && Array.isArray(input.workbooks)) ? input.workbooks : [];
    var csvInput = (input && Array.isArray(input.csv_files)) ? input.csv_files : [];

    var wbCount = workbooksInput.length;
    var csvCount = csvInput.length;
    var scopeStatus;
    var scopeNote;

    if (wbCount === 0 && csvCount === 0) {
      scopeStatus = "NO_INPUTS";
      scopeNote = "No .xlsx/.xlsm workbooks or instrument CSVs loaded yet.";
    } else if (wbCount > PACKAGE_MAX_WORKBOOKS || csvCount > PACKAGE_MAX_CSVS) {
      scopeStatus = "TIERED_ADDON_REQUIRED";
      scopeNote = "Submitted " + wbCount + " workbooks and " + csvCount + " CSVs exceeds the standard $1,495.00 package cap (5-8 core .xlsx workbooks + <=50 raw CSVs); tiered add-on required.";
    } else if (wbCount < PACKAGE_MIN_WORKBOOKS) {
      scopeStatus = "PARTIAL_SINGLE_WORKBOOK";
      scopeNote = "Screened " + wbCount + " workbook(s) and " + csvCount + " CSV(s). Standard $1,495.00 fixed-fee package covers 5-8 core .xlsx workbooks + <=50 raw calibration/test CSVs.";
    } else {
      scopeStatus = "WITHIN_STANDARD_SCOPE";
      scopeNote = "Within standard $1,495.00 fixed-fee scope (" + wbCount + " workbooks within 5-8 cap; " + csvCount + " CSVs within <=50 cap).";
    }

    var parsedWbs = [];
    var parsedCsvs = [];
    var shieldFindings = [];

    for (var wi = 0; wi < workbooksInput.length; wi++) {
      var wbSpec = workbooksInput[wi];
      var wb = await XLSXParser.parseXlsxArrayBuffer(wbSpec.data, wbSpec.filename);
      parsedWbs.push(wb);
      for (var ssi = 0; ssi < wb.shared_strings.length; ssi++) {
        shieldFindings = shieldFindings.concat(scanShieldText(wb.shared_strings[ssi], wb.filename, "sharedStrings[" + ssi + "]"));
      }
      for (var shi = 0; shi < wb.sheets.length; shi++) {
        var sh = wb.sheets[shi];
        shieldFindings = shieldFindings.concat(scanShieldText(sh.name, wb.filename, "sheet:" + sh.name));
        for (var tci = 0; tci < sh.all_text_cells.length; tci++) {
          var tc = sh.all_text_cells[tci];
          shieldFindings = shieldFindings.concat(scanShieldText(tc.text, wb.filename, sh.name + "!" + tc.ref));
        }
      }
    }

    for (var ci = 0; ci < csvInput.length; ci++) {
      var csvSpec = csvInput[ci];
      var parsedCsv = CSV.parseCSV(csvSpec.text, csvSpec.filename);
      parsedCsvs.push(parsedCsv);
      for (var hi = 0; hi < parsedCsv.headers.length; hi++) {
        shieldFindings = shieldFindings.concat(scanShieldText(parsedCsv.headers[hi], parsedCsv.filename, "header:" + parsedCsv.headers[hi]));
      }
      for (var ri = 0; ri < parsedCsv.rows.length; ri++) {
        var row = parsedCsv.rows[ri];
        var rowNo = row.__source_row || 0;
        var rKeys = Object.keys(row);
        for (var rki = 0; rki < rKeys.length; rki++) {
          var rk = rKeys[rki];
          if (rk === "__source_row") {
            continue;
          }
          shieldFindings = shieldFindings.concat(scanShieldText(String(row[rk] || ""), parsedCsv.filename, "row:" + rowNo + ":" + rk));
        }
      }
    }

    var defectCounts = {};
    for (var di = 0; di < ALL_RULE_IDS.length; di++) {
      defectCounts[ALL_RULE_IDS[di]] = 0;
    }

    if (shieldFindings.length > 0) {
      var fpBlocked = "fnv1a-" + CSV.fnv1aHex(sortedStringify({
        csvs: parsedCsvs.map(function (c) { return c.filename; }),
        shield: shieldFindings.length,
        workbooks: parsedWbs.map(function (w) { return w.filename; })
      }));
      return {
        verdict: "BLOCKED_SHIELD",
        blocked_by_shield: true,
        shield_findings: shieldFindings,
        scope_check: {
          workbook_count: wbCount,
          csv_count: csvCount,
          package_min_workbooks: PACKAGE_MIN_WORKBOOKS,
          package_max_workbooks: PACKAGE_MAX_WORKBOOKS,
          package_max_csvs: PACKAGE_MAX_CSVS,
          scope_status: scopeStatus,
          scope_note: scopeNote
        },
        defect_counts: defectCounts,
        total_defects: 0,
        workbook_defects: [],
        csv_defects: [],
        formula_cells_inspected: 0,
        csv_rows_inspected: 0,
        test_vector_matrix: [],
        fixed_fee_cents: FIXED_FEE_CENTS,
        avoided_reassessment_low_cents: AVOIDED_REASSESSMENT_LOW_CENTS,
        avoided_reassessment_high_cents: AVOIDED_REASSESSMENT_HIGH_CENTS,
        qa_hours_saved_low: QA_HOURS_SAVED_LOW,
        qa_hours_saved_high: QA_HOURS_SAVED_HIGH,
        input_fingerprint: fpBlocked
      };
    }

    var calRegister = {};
    for (var wbi = 0; wbi < parsedWbs.length; wbi++) {
      var pwb = parsedWbs[wbi];
      for (var wsi = 0; wsi < pwb.sheets.length; wsi++) {
        var ws = pwb.sheets[wsi];
        var sLow = ws.name.toLowerCase();
        var conv = rowsCellsToRecords(ws.rows_cells);
        if (conv.headers.length === 0) {
          continue;
        }
        var rcmap = buildCsvColumnMap(conv.headers);
        if ((sLow.indexOf("register") !== -1 || sLow.indexOf("cal") !== -1) && rcmap.equipment_id && rcmap.cal_due_date) {
          for (var rri = 0; rri < conv.records.length; rri++) {
            var rec = conv.records[rri];
            var eqKey = String(rec[rcmap.equipment_id] || "").trim().toUpperCase();
            var dueKey = parseDateKey(rec[rcmap.cal_due_date]);
            if (eqKey && dueKey) {
              calRegister[eqKey] = dueKey;
            }
          }
        }
      }
    }

    var registerCsvNames = {};
    for (var pci = 0; pci < parsedCsvs.length; pci++) {
      var pc = parsedCsvs[pci];
      var pcMap = buildCsvColumnMap(pc.headers);
      if (isRegisterCsv(pc.filename, pcMap)) {
        registerCsvNames[pc.filename] = true;
        if (pcMap.equipment_id && pcMap.cal_due_date) {
          for (var pri = 0; pri < pc.rows.length; pri++) {
            var prow = pc.rows[pri];
            var peq = String(prow[pcMap.equipment_id] || "").trim().toUpperCase();
            var pdue = parseDateKey(prow[pcMap.cal_due_date]);
            if (peq && pdue) {
              calRegister[peq] = pdue;
            }
          }
        }
      }
    }

    var workbookDefects = [];
    var testVectorMatrix = [];
    var formulaCellsInspected = 0;

    function addWbDefect(workbook, sheet, cell, ruleId, severity, category, detail, formula) {
      defectCounts[ruleId] += 1;
      workbookDefects.push({
        workbook: workbook,
        sheet: sheet,
        cell: cell,
        rule_id: ruleId,
        severity: severity,
        category: category,
        detail: detail,
        formula: formula || ""
      });
    }

    for (var i = 0; i < parsedWbs.length; i++) {
      var curWb = parsedWbs[i];
      var wbName = curWb.filename;
      if (curWb.external_links.length > 0) {
        addWbDefect(wbName, "(workbook)", "ARCHIVE", "C7112-EXT-01", "HIGH", "EXTERNAL_LINK", "External workbook link relationship detected (" + curWb.external_links.join(", ") + ").", "");
      }
      if (curWb.vba_bins.length > 0) {
        addWbDefect(wbName, "(workbook)", "ARCHIVE", "C7112-VBA-01", "HIGH", "UNVERIFIED_VBA", "Unverified VBA macro binary detected (" + curWb.vba_bins.join(", ") + ").", "");
      }

      for (var j = 0; j < curWb.sheets.length; j++) {
        var curSheet = curWb.sheets[j];
        var sname = curSheet.name;
        var fcells = curSheet.formula_cells;
        var sheetProtDefect = false;
        if (fcells.length > 0 && !curSheet.has_sheet_protection) {
          sheetProtDefect = true;
          addWbDefect(wbName, sname, "SHEET", "C7112-PROT-01", "HIGH", "MISSING_SHEET_PROTECTION", "Worksheet '" + sname + "' has " + fcells.length + " formula cell(s) without active <sheetProtection>.", "");
        }

        for (var fi = 0; fi < fcells.length; fi++) {
          formulaCellsInspected += 1;
          var fc = fcells[fi];
          var ref = fc.ref;
          var formula = fc.formula;
          var cachedVal = fc.cached_value;
          var ctype = fc.cell_type;
          var cellRules = [];
          if (sheetProtDefect) {
            cellRules.push("C7112-PROT-01");
          }
          if (curSheet.has_sheet_protection && fc.unlocked) {
            cellRules.push("C7112-PROT-02");
            addWbDefect(wbName, sname, ref, "C7112-PROT-02", "MEDIUM", "UNLOCKED_FORMULA_CELL", "Formula cell " + sname + "!" + ref + " uses unlocked protection style inside protected sheet.", formula);
          }

          var fa = analyzeFormulaText(formula);
          if (fa.has_external_ref) {
            cellRules.push("C7112-EXT-01");
            addWbDefect(wbName, sname, ref, "C7112-EXT-01", "HIGH", "EXTERNAL_LINK", "Formula in " + sname + "!" + ref + " references an external workbook.", formula);
          }

          var cachedErrMatch = FORMULA_ERROR_RE.exec(cachedVal || "");
          if (fa.has_error_token || cachedErrMatch || ctype === "e") {
            var errTok = fa.error_token || (cachedErrMatch ? cachedErrMatch[0] : (cachedVal || "#ERROR"));
            cellRules.push("C7112-ERR-01");
            addWbDefect(wbName, sname, ref, "C7112-ERR-01", "CRITICAL", "BROKEN_FORMULA_ERROR", "Broken spreadsheet error token (" + errTok + ") in " + sname + "!" + ref + ".", formula);
          }

          if (fa.has_volatile) {
            cellRules.push("C7112-VOL-01");
            addWbDefect(wbName, sname, ref, "C7112-VOL-01", "MEDIUM", "VOLATILE_FUNCTION", "Volatile function " + fa.volatile_name + "() in " + sname + "!" + ref + " defeats deterministic recalculation.", formula);
          }

          if (fa.has_unguarded_div) {
            cellRules.push("C7112-DIV-01");
            addWbDefect(wbName, sname, ref, "C7112-DIV-01", "HIGH", "UNGUARDED_DIVISION", "Division operator '/' in " + sname + "!" + ref + " lacks IFERROR() zero-denominator guard.", formula);
          }

          if (fa.magic_constants.length > 0) {
            cellRules.push("C7112-MAGIC-01");
            addWbDefect(wbName, sname, ref, "C7112-MAGIC-01", "MEDIUM", "HARDCODED_MAGIC_CONSTANT", "Hardcoded numeric constant(s) " + fa.magic_constants.join(", ") + " embedded in " + sname + "!" + ref + ".", formula);
          }

          testVectorMatrix = testVectorMatrix.concat(
            buildTestVectorsForFormula(wbName, sname, ref, formula, cellRules)
          );
        }
      }
    }

    var csvDefects = [];
    var csvRowsInspected = 0;

    function addCsvDefect(csvFile, row, equipmentId, ruleId, severity, detail) {
      defectCounts[ruleId] += 1;
      csvDefects.push({
        csv_file: csvFile,
        row: row,
        equipment_id: equipmentId || "(missing)",
        rule_id: ruleId,
        severity: severity,
        detail: detail
      });
    }

    for (var pi = 0; pi < parsedCsvs.length; pi++) {
      var curCsv = parsedCsvs[pi];
      if (registerCsvNames[curCsv.filename]) {
        continue;
      }
      var cmap = buildCsvColumnMap(curCsv.headers);
      var eqCol = cmap.equipment_id || "";
      var opCol = cmap.operator_id || "";
      var tdCol = cmap.test_date || "";
      var dueCol = cmap.cal_due_date || "";
      var tempCol = cmap.temp_c || "";
      var rhCol = cmap.humidity_pct || "";

      for (var rj = 0; rj < curCsv.rows.length; rj++) {
        csvRowsInspected += 1;
        var crow = curCsv.rows[rj];
        var rowNum = crow.__source_row || 0;
        var eqVal = eqCol ? String(crow[eqCol] || "").trim() : "";
        var opVal = opCol ? String(crow[opCol] || "").trim() : "";
        var tdRaw = tdCol ? String(crow[tdCol] || "").trim() : "";
        var dueRaw = dueCol ? String(crow[dueCol] || "").trim() : "";
        var tempRaw = tempCol ? String(crow[tempCol] || "").trim() : "";
        var rhRaw = rhCol ? String(crow[rhCol] || "").trim() : "";

        if (!eqVal) {
          addCsvDefect(curCsv.filename, rowNum, "", "C64-EQUIP-01", "HIGH", "Row " + rowNum + ": missing equipment_id (Clause 6.4 asset traceability gap).");
        }
        if (!opVal) {
          addCsvDefect(curCsv.filename, rowNum, eqVal, "C75-OPER-01", "HIGH", "Row " + rowNum + ": missing operator_id (Clause 7.5 technical record traceability gap).");
        }
        if (!isNumericValue(tempRaw) || !isNumericValue(rhRaw)) {
          var missingEnv = [];
          if (!isNumericValue(tempRaw)) {
            missingEnv.push("temp_c");
          }
          if (!isNumericValue(rhRaw)) {
            missingEnv.push("humidity_pct");
          }
          addCsvDefect(curCsv.filename, rowNum, eqVal, "C75-ENV-01", "MEDIUM", "Row " + rowNum + ": missing or non-numeric environmental log (" + missingEnv.join(", ") + ").");
        }

        var testDt = parseDateKey(tdRaw);
        var regDue = eqVal ? (calRegister[eqVal.toUpperCase()] || null) : null;
        var inlineDue = parseDateKey(dueRaw);
        var effDue = regDue || inlineDue;

        if (eqVal && !effDue) {
          addCsvDefect(curCsv.filename, rowNum, eqVal, "C64-REG-01", "HIGH", "Row " + rowNum + ": equipment_id '" + eqVal + "' has no calibration due date in register or CSV.");
        } else if (testDt && effDue && testDt > effDue) {
          addCsvDefect(curCsv.filename, rowNum, eqVal, "C64-EXP-01", "CRITICAL", "Row " + rowNum + ": calibration expired for '" + eqVal + "' (test_date " + testDt + " > cal_due_date " + effDue + ").");
        }
      }
    }

    var totalDefects = workbookDefects.length + csvDefects.length;
    var verdict = totalDefects > 0 ? "DEFECTS_FOUND" : "CLEAN_READY";
    var fp = "fnv1a-" + CSV.fnv1aHex(sortedStringify({
      csv_rows: csvRowsInspected,
      csvs: parsedCsvs.map(function (c) { return c.filename; }),
      defect_counts: defectCounts,
      formula_cells: formulaCellsInspected,
      workbooks: parsedWbs.map(function (w) { return w.filename; })
    }));

    return {
      verdict: verdict,
      blocked_by_shield: false,
      shield_findings: [],
      scope_check: {
        workbook_count: wbCount,
        csv_count: csvCount,
        package_min_workbooks: PACKAGE_MIN_WORKBOOKS,
        package_max_workbooks: PACKAGE_MAX_WORKBOOKS,
        package_max_csvs: PACKAGE_MAX_CSVS,
        scope_status: scopeStatus,
        scope_note: scopeNote
      },
      defect_counts: defectCounts,
      total_defects: totalDefects,
      workbook_defects: workbookDefects,
      csv_defects: csvDefects,
      formula_cells_inspected: formulaCellsInspected,
      csv_rows_inspected: csvRowsInspected,
      test_vector_matrix: testVectorMatrix,
      fixed_fee_cents: FIXED_FEE_CENTS,
      avoided_reassessment_low_cents: AVOIDED_REASSESSMENT_LOW_CENTS,
      avoided_reassessment_high_cents: AVOIDED_REASSESSMENT_HIGH_CENTS,
      qa_hours_saved_low: QA_HOURS_SAVED_LOW,
      qa_hours_saved_high: QA_HOURS_SAVED_HIGH,
      input_fingerprint: fp
    };
  }

  function escapeCsvField(val) {
    var s = String(val === null || val === undefined ? "" : val);
    if (/[",\r\n]/.test(s)) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function generateTraceabilityCsv(result) {
    var headers = ["source_type", "file", "location", "rule_id", "severity", "detail"];
    var out = [headers.join(",")];
    var wbDefects = (result && Array.isArray(result.workbook_defects)) ? result.workbook_defects : [];
    var csvDefects = (result && Array.isArray(result.csv_defects)) ? result.csv_defects : [];
    for (var i = 0; i < wbDefects.length; i++) {
      var d = wbDefects[i];
      out.push(["WORKBOOK", d.workbook, d.sheet + "!" + d.cell, d.rule_id, d.severity, d.detail].map(escapeCsvField).join(","));
    }
    for (var j = 0; j < csvDefects.length; j++) {
      var c = csvDefects[j];
      out.push(["INSTRUMENT_CSV", c.csv_file, "Row " + c.row + " (" + c.equipment_id + ")", c.rule_id, c.severity, c.detail].map(escapeCsvField).join(","));
    }
    return out.join("\r\n");
  }

  function escapeHtml(str) {
    return String(str === null || str === undefined ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function generatePrintableBriefHtml(result, config) {
    var cfg = config || {};
    var res = result || {};
    var title = cfg.SITE_TITLE || "ISO/IEC 17025:2017 Clause 7.11.2 Pre-Scan";
    var privacy = cfg.PRIVACY_BAR_TEXT || "100% Browser-Local Analysis — Your file never leaves your browser; zero server upload.";
    var disclaimer = cfg.LEGAL_DISCLAIMER_BANNER || "Non-audit technical pre-scan; not an accreditation body; does not provide certification or legal advice; $1,495.00 fixed non-contingent fee.";
    var wbRows = (res.workbook_defects || []).slice(0, 12).map(function (d) {
      return "<tr><td>" + escapeHtml(d.workbook) + "</td><td>" + escapeHtml(d.sheet + "!" + d.cell) + "</td><td>" + escapeHtml(d.rule_id) + "</td><td>" + escapeHtml(d.severity) + "</td><td>" + escapeHtml(d.detail) + "</td></tr>";
    }).join("");
    var csvRows = (res.csv_defects || []).slice(0, 12).map(function (c) {
      return "<tr><td>" + escapeHtml(c.csv_file) + "</td><td>Row " + escapeHtml(c.row) + "</td><td>" + escapeHtml(c.rule_id) + "</td><td>" + escapeHtml(c.severity) + "</td><td>" + escapeHtml(c.detail) + "</td></tr>";
    }).join("");
    return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>" + escapeHtml(title) + "</title>" +
      "<style>body{font-family:system-ui,sans-serif;font-size:11px;padding:18px;color:#0f172a}table{width:100%;border-collapse:collapse;margin:10px 0}th,td{border:1px solid #cbd5e1;padding:4px 6px;text-align:left}th{background:#f1f5f9}.bar{background:#ecfdf5;border:1px solid #059669;padding:6px;margin-bottom:8px}.warn{background:#fef3c7;border:1px solid #d97706;padding:6px;margin-bottom:8px;font-weight:700}</style></head><body>" +
      "<h2>" + escapeHtml(title) + " (" + escapeHtml(res.verdict || "") + ")</h2>" +
      "<div class=\"bar\">" + escapeHtml(privacy) + "</div>" +
      "<div class=\"warn\">" + escapeHtml(disclaimer) + "</div>" +
      "<p><strong>Fingerprint:</strong> " + escapeHtml(res.input_fingerprint || "") + " | <strong>Total Defects:</strong> " + escapeHtml(res.total_defects || 0) + " | <strong>Formula Cells:</strong> " + escapeHtml(res.formula_cells_inspected || 0) + " | <strong>CSV Rows:</strong> " + escapeHtml(res.csv_rows_inspected || 0) + "</p>" +
      "<table><thead><tr><th>File</th><th>Location</th><th>Rule ID</th><th>Severity</th><th>Detail</th></tr></thead><tbody>" + wbRows + csvRows + "</tbody></table>" +
      "</body></html>";
  }

  return {
    ALL_RULE_IDS: ALL_RULE_IDS,
    analyzeFormulaText: analyzeFormulaText,
    evaluateBundle: evaluateBundle,
    generateTraceabilityCsv: generateTraceabilityCsv,
    generatePrintableBriefHtml: generatePrintableBriefHtml
  };
}));
