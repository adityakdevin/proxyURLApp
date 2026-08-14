-- Same two answers as qaCaseDiagnostics.ts, as plain SQL — for a production/UAT box where
-- devDependencies (tsx) are not installed. MySQL 8 (JSON_TABLE).
--
--   mysql -h 127.0.0.1 -P 3307 -u root -p proxyapp_db < qaCaseDiagnostics.sql
--
-- Both facts are already stored by any validation run; no source documents needed.

-- 1. TRUE page count per document (readPdfInfo stores doc.numPages, NOT the scan cap).
--    Confirms whether the page ceiling truncated S.No 19 / 20.
SELECT
  c.vin_no,
  JSON_UNQUOTE(JSON_EXTRACT(x.doc, '$.fileName'))         AS file_name,
  JSON_UNQUOTE(JSON_EXTRACT(x.doc, '$.properties.Pages')) AS true_page_count,
  vr.created_at
FROM claims c
JOIN validation_results vr
  ON vr.claim_id = c.id AND vr.validator_key = 'META' AND vr.details IS NOT NULL
 -- Latest run only. A claim re-validated N times has N results per validator (one local
 -- claim had 88), and every one of them would otherwise come back as a duplicate row.
 AND vr.created_at = (
   SELECT MAX(v2.created_at) FROM validation_results v2
   WHERE v2.claim_id = vr.claim_id AND v2.validator_key = vr.validator_key
 )
JOIN JSON_TABLE(vr.details, '$.extracted[*]' COLUMNS (doc JSON PATH '$')) x
WHERE c.vin_no IN (
  'MZBGB813LTN308495',  -- S.No 11  Scrappage QR
  'MZBEU813LSN749087',  -- S.No 16  GST QR
  'MZBET815VSN751228',  -- S.No 17  GST QR
  'MZBGB814LSN298909',  -- S.No 19  failed to scan all required documents
  'MZBFB813LSN603467'   -- S.No 20  failed to scan PAN QR
)
ORDER BY c.vin_no, vr.created_at DESC;

-- 2. Decoded QR payloads. The KEY NAMES are what QR_KEY_TO_LABELS needs; the values carry
--    PAN / Aadhaar / GST / customer data, so share the keys rather than the whole payload
--    if you would rather not send it.
SELECT
  c.vin_no,
  JSON_UNQUOTE(JSON_EXTRACT(q.hit, '$.fileName')) AS file_name,
  JSON_UNQUOTE(JSON_EXTRACT(q.hit, '$.page'))     AS page,
  JSON_UNQUOTE(JSON_EXTRACT(q.hit, '$.value'))    AS qr_payload,
  vr.status,
  vr.summary,
  vr.created_at
FROM claims c
JOIN validation_results vr
  ON vr.claim_id = c.id AND vr.validator_key = 'QR' AND vr.details IS NOT NULL
 AND vr.created_at = (
   SELECT MAX(v2.created_at) FROM validation_results v2
   WHERE v2.claim_id = vr.claim_id AND v2.validator_key = vr.validator_key
 )
JOIN JSON_TABLE(vr.details, '$.decoded[*]' COLUMNS (hit JSON PATH '$')) q
WHERE c.vin_no IN (
  'MZBGB813LTN308495', 'MZBEU813LSN749087', 'MZBET815VSN751228',
  'MZBGB814LSN298909', 'MZBFB813LSN603467'
)
ORDER BY c.vin_no, vr.created_at DESC;

-- 3. Sanity check: are these claims in this database at all, and were they validated?
SELECT
  c.vin_no,
  c.claim_id,
  c.scheme_type,
  (SELECT COUNT(*) FROM documents d WHERE d.claim_id = c.id)          AS docs,
  (SELECT COUNT(*) FROM validation_results v WHERE v.claim_id = c.id) AS results,
  c.spell_check_status,
  c.qr_status,
  c.full_scan_status
FROM claims c
WHERE c.vin_no IN (
  'MZBGB813LTN308495', 'MZBEU813LSN749087', 'MZBET815VSN751228',
  'MZBGB814LSN298909', 'MZBFB813LSN603467'
);
