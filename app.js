(function (root) {
  "use strict";

  var ENGINE = root.PRESCAN_ENGINE;
  var CONFIG = root.SITE_CONFIG || {};
  var SAMPLES = root.PRESCAN_SAMPLES || {};
  var XLSXParser = root.XLSXLocalParser;

  var state = {
    workbooks: [],
    csv_files: [],
    lastResult: null,
    activeTab: "ALL_DEFECTS"
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str === null || str === undefined ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function setFileStatus(msg, isError) {
    var el = byId("file-status");
    if (!el) {
      return;
    }
    el.textContent = msg;
    el.className = isError ? "file-status is-error" : "file-status is-ok";
  }

  function renderLoadedChips() {
    var row = byId("loaded-files-row");
    if (!row) {
      return;
    }
    var chips = [];
    for (var i = 0; i < state.workbooks.length; i++) {
      chips.push("<span class=\"file-chip\">XLSX: " + escapeHtml(state.workbooks[i].filename) + "</span>");
    }
    for (var j = 0; j < state.csv_files.length; j++) {
      chips.push("<span class=\"file-chip\">CSV: " + escapeHtml(state.csv_files[j].filename) + "</span>");
    }
    row.innerHTML = chips.join("");
  }

  function showShieldAlert(findings) {
    var el = byId("shield-alert");
    var list = byId("shield-findings-list");
    if (!el || !list) {
      return;
    }
    list.innerHTML = findings.map(function (f) {
      return "<li>" + escapeHtml(f.detail) + "</li>";
    }).join("");
    el.hidden = false;
  }

  function hideShieldAlert() {
    var el = byId("shield-alert");
    var list = byId("shield-findings-list");
    if (el) {
      el.hidden = true;
    }
    if (list) {
      list.innerHTML = "";
    }
  }

  async function runEvaluation() {
    renderLoadedChips();
    if (state.workbooks.length === 0 && state.csv_files.length === 0) {
      var step3Empty = byId("step-3");
      if (step3Empty) {
        step3Empty.hidden = true;
      }
      setFileStatus("No local workbooks or CSVs loaded yet.", false);
      return;
    }
    setFileStatus(
      "Loaded locally: " + state.workbooks.length + " workbook(s) + " + state.csv_files.length + " CSV(s). Screening in browser...",
      false
    );
    try {
      var result = await ENGINE.evaluateBundle({
        workbooks: state.workbooks,
        csv_files: state.csv_files
      });
      if (result.blocked_by_shield) {
        state.lastResult = null;
        var step3Blocked = byId("step-3");
        if (step3Blocked) {
          step3Blocked.hidden = true;
        }
        showShieldAlert(result.shield_findings || []);
        setFileStatus("Halted by Local Defense / Export-Control / Clinical PHI Shield.", true);
        return;
      }
      hideShieldAlert();
      state.lastResult = result;
      state.activeTab = "ALL_DEFECTS";
      setFileStatus(
        "Screened locally: " + state.workbooks.length + " workbook(s), " + state.csv_files.length + " CSV(s) (" + result.total_defects + " defect(s) flagged).",
        false
      );
      renderResult(result);
    } catch (err) {
      setFileStatus("Local parse error: " + (err && err.message ? err.message : String(err)), true);
    }
  }

  function renderResult(result) {
    var step3 = byId("step-3");
    if (step3) {
      step3.hidden = false;
    }
    var badge = byId("verdict-badge");
    if (badge) {
      var hasDefects = result.verdict === "DEFECTS_FOUND";
      badge.textContent = hasDefects
        ? "DEFECTS FOUND (" + result.total_defects + " Clause 7.11.2 / 6.4/7.5 Gaps)"
        : "CLEAN BELOW THRESHOLD (0 Defects Detected)";
      badge.className = "verdict-badge " + (hasDefects ? "badge-defects" : "badge-clean");
    }

    var scopeEl = byId("result-scope");
    if (scopeEl && result.scope_check) {
      scopeEl.textContent = result.scope_check.scope_status + " \u2014 " + result.scope_check.scope_note;
    }
    var fpEl = byId("result-fingerprint");
    if (fpEl) {
      fpEl.textContent = result.input_fingerprint;
    }
    var kpiDefects = byId("kpi-defects");
    if (kpiDefects) {
      kpiDefects.textContent = String(result.total_defects);
    }
    var kpiDefectsSub = byId("kpi-defects-sub");
    if (kpiDefectsSub) {
      kpiDefectsSub.textContent = result.workbook_defects.length + " workbook | " + result.csv_defects.length + " CSV";
    }
    var kpiCov = byId("kpi-coverage");
    if (kpiCov) {
      kpiCov.textContent = result.formula_cells_inspected + " / " + result.csv_rows_inspected;
    }
    var kpiVecSub = byId("kpi-vectors-sub");
    if (kpiVecSub) {
      kpiVecSub.textContent = result.test_vector_matrix.length + " verification test vectors";
    }

    renderTabs(result);
    renderTable(result);
    renderMailto(result);
  }

  function renderTabs(result) {
    var tabsEl = byId("filter-tabs");
    if (!tabsEl) {
      return;
    }
    var specs = [
      { key: "ALL_DEFECTS", label: "All Defects (" + result.total_defects + ")" },
      { key: "WB_DEFECTS", label: "Workbook Clause 7.11.2 (" + result.workbook_defects.length + ")" },
      { key: "CSV_DEFECTS", label: "Instrument CSV 6.4/7.5 (" + result.csv_defects.length + ")" },
      { key: "VECTORS", label: "Clause 7.11.2 Test Vectors (" + result.test_vector_matrix.length + ")" }
    ];
    tabsEl.innerHTML = specs.map(function (sp) {
      var cls = "filter-tab" + (state.activeTab === sp.key ? " is-active" : "");
      return "<button type=\"button\" class=\"" + cls + "\" data-tab=\"" + escapeHtml(sp.key) + "\">" + escapeHtml(sp.label) + "</button>";
    }).join("");

    var btns = tabsEl.querySelectorAll("button[data-tab]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function (ev) {
        state.activeTab = ev.currentTarget.getAttribute("data-tab") || "ALL_DEFECTS";
        renderTabs(state.lastResult);
        renderTable(state.lastResult);
      });
    }
  }

  function renderTable(result) {
    var thead = byId("trace-thead");
    var tbody = byId("trace-tbody");
    if (!thead || !tbody) {
      return;
    }
    if (state.activeTab === "VECTORS") {
      thead.innerHTML = "<tr><th>Workbook</th><th>Location</th><th>Formula</th><th>Vector Case</th><th>Test Input</th><th>Expected Behavior</th><th>Status</th></tr>";
      if (result.test_vector_matrix.length === 0) {
        tbody.innerHTML = "<tr><td colspan=\"7\" class=\"empty-cell\">No formula cells found for test vector generation.</td></tr>";
        return;
      }
      tbody.innerHTML = result.test_vector_matrix.map(function (v) {
        return "<tr>" +
          "<td>" + escapeHtml(v.workbook) + "</td>" +
          "<td><code>" + escapeHtml(v.sheet + "!" + v.cell) + "</code></td>" +
          "<td><code>" + escapeHtml(v.formula) + "</code></td>" +
          "<td><strong>" + escapeHtml(v.vector_case) + "</strong></td>" +
          "<td>" + escapeHtml(v.input_summary) + "</td>" +
          "<td>" + escapeHtml(v.expected_behavior) + "</td>" +
          "<td><span class=\"sev-pill sev-" + escapeHtml(v.status) + "\">" + escapeHtml(v.status) + "</span></td>" +
          "</tr>";
      }).join("");
      return;
    }

    thead.innerHTML = "<tr><th>Source Type</th><th>File</th><th>Location</th><th>Rule ID</th><th>Severity</th><th>Detail</th></tr>";
    var rows = [];
    if (state.activeTab === "ALL_DEFECTS" || state.activeTab === "WB_DEFECTS") {
      for (var i = 0; i < result.workbook_defects.length; i++) {
        var wd = result.workbook_defects[i];
        rows.push({
          source_type: "WORKBOOK",
          file: wd.workbook,
          location: wd.sheet + "!" + wd.cell,
          rule_id: wd.rule_id,
          severity: wd.severity,
          detail: wd.detail + (wd.formula ? (" [" + wd.formula + "]") : "")
        });
      }
    }
    if (state.activeTab === "ALL_DEFECTS" || state.activeTab === "CSV_DEFECTS") {
      for (var j = 0; j < result.csv_defects.length; j++) {
        var cd = result.csv_defects[j];
        rows.push({
          source_type: "INSTRUMENT_CSV",
          file: cd.csv_file,
          location: "Row " + cd.row + " (" + cd.equipment_id + ")",
          rule_id: cd.rule_id,
          severity: cd.severity,
          detail: cd.detail
        });
      }
    }
    if (rows.length === 0) {
      tbody.innerHTML = "<tr><td colspan=\"6\" class=\"empty-cell\">Zero defects detected in this view.</td></tr>";
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      return "<tr>" +
        "<td>" + escapeHtml(r.source_type) + "</td>" +
        "<td>" + escapeHtml(r.file) + "</td>" +
        "<td><code>" + escapeHtml(r.location) + "</code></td>" +
        "<td><code>" + escapeHtml(r.rule_id) + "</code></td>" +
        "<td><span class=\"sev-pill sev-" + escapeHtml(r.severity) + "\">" + escapeHtml(r.severity) + "</span></td>" +
        "<td>" + escapeHtml(r.detail) + "</td>" +
        "</tr>";
    }).join("");
  }

  function buildMailtoPayload(result) {
    var email = CONFIG.CONTACT_EMAIL || "intake@scan.far31prescan.com";
    var subject = "[ISO 17025 Clause 7.11.2 Pre-Scan] " + result.verdict + " | " + result.input_fingerprint;
    var body = [
      "Hello Validation Readiness Desk,",
      "",
      "I ran the browser-local Clause 7.11.2 pre-scan (zero raw files uploaded):",
      "- Verdict: " + result.verdict,
      "- Fingerprint: " + result.input_fingerprint,
      "- Scope: " + result.scope_check.workbook_count + " workbook(s), " + result.scope_check.csv_count + " CSV(s) (" + result.scope_check.scope_status + ")",
      "- Formula Cells Inspected: " + result.formula_cells_inspected + " (" + result.test_vector_matrix.length + " test vectors)",
      "- CSV Rows Inspected: " + result.csv_rows_inspected,
      "- Total Defects Flagged: " + result.total_defects,
      "- Package: $1,495.00 fixed non-contingent fee (5-8 core .xlsx workbooks + <=50 raw CSVs)",
      "",
      "All workbooks and instrument CSVs remain strictly on our local machine."
    ].join("\n");
    var href = "mailto:" + encodeURIComponent(email) +
      "?subject=" + encodeURIComponent(subject) +
      "&body=" + encodeURIComponent(body);
    return { email: email, subject: subject, body: body, href: href };
  }

  function renderMailto(result) {
    var payload = buildMailtoPayload(result);
    var linkEl = byId("mailto-link");
    if (linkEl) {
      linkEl.setAttribute("href", payload.href);
    }
    var prev = byId("mailto-preview");
    if (prev) {
      prev.textContent = "To: " + payload.email + "\nSubject: " + payload.subject + "\n\n" + payload.body;
    }
  }

  function triggerDownload(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function loadSample(sampleKey) {
    var sample = SAMPLES[sampleKey];
    if (!sample) {
      return;
    }
    state.workbooks = (sample.workbooks || []).map(function (w) {
      return {
        filename: w.filename,
        data: XLSXParser.decodeBase64ToUint8Array(w.base64)
      };
    });
    state.csv_files = (sample.csv_files || []).map(function (c) {
      return {
        filename: c.filename,
        text: c.text
      };
    });
    runEvaluation();
  }

  function readLocalFileAsync(file) {
    return new Promise(function (resolve, reject) {
      var nameLower = String(file.name || "").toLowerCase();
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("Failed to read " + file.name));
      };
      if (nameLower.endsWith(".xlsx") || nameLower.endsWith(".xlsm")) {
        reader.onload = function (ev) {
          resolve({ kind: "xlsx", filename: file.name, data: ev.target.result });
        };
        reader.readAsArrayBuffer(file);
      } else {
        reader.onload = function (ev) {
          resolve({ kind: "csv", filename: file.name, text: String(ev.target.result || "") });
        };
        reader.readAsText(file);
      }
    });
  }

  async function handleLocalFiles(fileList) {
    if (!fileList || fileList.length === 0) {
      return;
    }
    var files = Array.prototype.slice.call(fileList);
    for (var i = 0; i < files.length; i++) {
      var loaded = await readLocalFileAsync(files[i]);
      if (loaded.kind === "xlsx") {
        state.workbooks.push({ filename: loaded.filename, data: loaded.data });
      } else {
        state.csv_files.push({ filename: loaded.filename, text: loaded.text });
      }
    }
    await runEvaluation();
  }

  function bindEvents() {
    var qBtn = byId("sample-qualified-btn");
    if (qBtn) {
      qBtn.addEventListener("click", function () { loadSample("qualified"); });
    }
    var bBtn = byId("sample-below-btn");
    if (bBtn) {
      bBtn.addEventListener("click", function () { loadSample("below_threshold"); });
    }
    var clearBtn = byId("clear-files-btn");
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        state.workbooks = [];
        state.csv_files = [];
        state.lastResult = null;
        hideShieldAlert();
        runEvaluation();
      });
    }
    var input = byId("file-input");
    if (input) {
      input.addEventListener("change", function (ev) {
        if (ev.target && ev.target.files) {
          handleLocalFiles(ev.target.files);
          ev.target.value = "";
        }
      });
    }
    var dz = byId("dropzone");
    if (dz) {
      dz.addEventListener("dragover", function (ev) {
        ev.preventDefault();
        dz.classList.add("is-dragover");
      });
      dz.addEventListener("dragleave", function () {
        dz.classList.remove("is-dragover");
      });
      dz.addEventListener("drop", function (ev) {
        ev.preventDefault();
        dz.classList.remove("is-dragover");
        if (ev.dataTransfer && ev.dataTransfer.files) {
          handleLocalFiles(ev.dataTransfer.files);
        }
      });
    }
    var dlCsv = byId("download-csv-btn");
    if (dlCsv) {
      dlCsv.addEventListener("click", function () {
        if (!state.lastResult) {
          return;
        }
        triggerDownload(
          "clause7112_traceability_" + state.lastResult.input_fingerprint + ".csv",
          ENGINE.generateTraceabilityCsv(state.lastResult),
          "text/csv;charset=utf-8"
        );
      });
    }
    var dlBrief = byId("download-brief-btn");
    if (dlBrief) {
      dlBrief.addEventListener("click", function () {
        if (!state.lastResult) {
          return;
        }
        triggerDownload(
          "clause7112_brief_" + state.lastResult.input_fingerprint + ".html",
          ENGINE.generatePrintableBriefHtml(state.lastResult, CONFIG),
          "text/html;charset=utf-8"
        );
      });
    }
    var printBtn = byId("print-brief-btn");
    if (printBtn) {
      printBtn.addEventListener("click", function () {
        if (typeof root.print === "function") {
          root.print();
        }
      });
    }
    var copyBtn = byId("copy-mailto-btn");
    if (copyBtn) {
      copyBtn.addEventListener("click", function () {
        if (!state.lastResult) {
          return;
        }
        var p = buildMailtoPayload(state.lastResult);
        var txt = "To: " + p.email + "\nSubject: " + p.subject + "\n\n" + p.body;
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(txt).then(function () {
            copyBtn.textContent = "Copied Summary";
            setTimeout(function () {
              copyBtn.textContent = "Copy Summary & Email";
            }, 1800);
          });
        }
      });
    }
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", bindEvents);
    } else {
      bindEvents();
    }
  }
}(typeof globalThis !== "undefined" ? globalThis : this));
