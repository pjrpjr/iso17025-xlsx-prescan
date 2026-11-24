(function (root) {
  "use strict";

  var SITE_CONFIG = {
    SITE_TITLE: "ISO/IEC 17025:2017 Clause 7.11.2 Workbook & CSV Pre-Scan",
    BRAND_BADGE: "100% BROWSER-LOCAL TESTING LAB SCREENING",
    PRIVACY_BAR_TEXT: "100% Browser-Local Analysis \u2014 Your file never leaves your browser; zero server upload.",
    LEGAL_DISCLAIMER_BANNER: "INDEPENDENT NON-AUDIT & NON-ACCREDITATION TOOL: This browser-local pre-scan is an informational engineering readiness check only. It is non-audit, not an audit report, is not an accreditation body (not affiliated with A2LA, ANAB, NVLAP, or PJLA), and does not provide certification, accreditation, or legal advice. Package scope is strictly 5-8 core .xlsx workbooks plus up to 50 raw instrument/calibration CSVs for a $1,495.00 fixed non-contingent fee (0% commission, never a contingent fee). Your laboratory Quality Manager locally executes and approves final Clause 7.11.2 validation sign-off. Zero DoD, ITAR, EAR, AMS2750, Nadcap, CUI, or clinical PHI permitted.",
    FIXED_FEE_CENTS: 149500,
    PACKAGE_MIN_WORKBOOKS: 5,
    PACKAGE_MAX_WORKBOOKS: 8,
    PACKAGE_MAX_CSVS: 50,
    CONTACT_EMAIL: "intake@scan.far31prescan.com",
    SENDER_IDENTITY: "Independent Clause 7.11.2 Readiness Desk (Non-Audit, Non-Accreditation Engineering Tool)",
    SAMPLES_META: {
      qualified: {
        id: "qualified",
        label: "Load Qualified Lab Sample (.xlsx + CSVs with Clause 7.11.2 & 6.4 Defects)"
      },
      below_threshold: {
        id: "below_threshold",
        label: "Load Clean Below-Threshold Sample (Protected .xlsx + Compliant CSVs)"
      }
    }
  };

  root.SITE_CONFIG = SITE_CONFIG;
  if (typeof module === "object" && module.exports) {
    module.exports = SITE_CONFIG;
  }
}(typeof globalThis !== "undefined" ? globalThis : this));
