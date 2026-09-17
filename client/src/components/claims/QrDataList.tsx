export interface QrEntry {
  fileName: string;
  value: string;
  page?: number;
}

/** Policy QR payloads are "Label:Value" fields joined by "|" (or ","). Split each
 *  field at its label colon — skipping time colons like "11:43AM" — or, for fields
 *  whose colon was omitted ("OD period02 Jul 2025…"), at the first digit. Returns
 *  [] when the payload isn't field-shaped so the caller falls back to raw text. */
function parseQrFields(value: string): [string, string][] {
  // Aadhaar QRs carry XML (<PrintLetterBarcodeData uid="…" name="…"/>) —
  // show its attributes as rows.
  if (value.trimStart().startsWith('<')) {
    const attrs = [...value.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)].map(
      (m): [string, string] => [m[1], m[2]]
    );
    return attrs.length >= 2 ? attrs : [];
  }
  const sep = value.includes('|') ? '|' : ',';
  const pairs: [string, string][] = [];
  for (const part of value.split(sep)) {
    const p = part.trim();
    if (!p) continue;
    // First colon that isn't a time colon ("11:43AM" — digit on BOTH sides).
    const colon = /(?<!\d):|:(?!\d)/.exec(p);
    if (colon && colon.index > 0) {
      pairs.push([p.slice(0, colon.index).trim(), p.slice(colon.index + 1).trim()]);
      continue;
    }
    const digit = /^([A-Za-z. ]{2,}?)\s*(\d.*)$/.exec(p);
    if (digit) pairs.push([digit[1].trim(), digit[2].trim()]);
    else pairs.push(['', p]);
  }
  return pairs.filter(([label]) => label).length >= 2 ? pairs : [];
}

/**
 * A payload the server could not expand into fields. Two shapes, and the second is the one
 * that matters: a base64 blob prefixed `binary:`, OR a long run of DIGITS.
 *
 * An Aadhaar/PAN secure QR encodes its record as one huge number, which is printable text —
 * so the old prefix-only test called it readable and this dialog printed a ~3,000-digit
 * number at the reviewer. The server expands Aadhaar itself now; anything still numeric when
 * it reaches here is one we genuinely cannot read.
 */
const isOpaqueQrValue = (v: string) => v.startsWith('binary:') || /^\d{200,}$/.test(v);
const OPAQUE_QR_HELP =
  'This QR code holds an encoded record that cannot be expanded here. Scan the physical card ' +
  'with the official reader app — the PAN QR Code Reader app for a PAN card, or mAadhaar / ' +
  'the Aadhaar QR Scanner app for an Aadhaar card.';

/** Raw payloads are debugging detail. Elide long ones wherever they are shown, so no payload
 *  shape — present or future — can put a wall of characters in front of a reviewer. */
const rawPreview = (v: string) =>
  v.length <= 300 ? v : `${v.slice(0, 300)}… (${v.length.toLocaleString()} characters)`;

function RawPayload({ value }: { value: string }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-gray-400">Raw QR payload</summary>
      <div className="mt-1 break-all text-xs text-gray-500">{rawPreview(value)}</div>
    </details>
  );
}

/**
 * The decoded QR codes, field by field. Shared by the claim page's "View QR Data" dialog and
 * the document viewer's side panel, so the two can never show a reviewer different details.
 */
export function QrDataList({
  entries,
  onJumpToPage,
}: {
  entries: QrEntry[];
  /** When given, the page label scrolls the document viewer to that page. */
  onJumpToPage?: (page: number) => void;
}) {
  return (
    <div className="space-y-4 text-sm">
      {entries.map((q, i) => {
        const fields = parseQrFields(q.value);
        return (
          <div key={i}>
            <div className="font-medium">
              {q.fileName}
              {q.page != null &&
                (onJumpToPage ? (
                  <button
                    type="button"
                    onClick={() => onJumpToPage(q.page!)}
                    title="Scroll the document to this page"
                    className="ml-2 font-normal text-blue-600 hover:underline"
                  >
                    page {q.page}
                  </button>
                ) : (
                  <span className="ml-2 font-normal text-gray-400">page {q.page}</span>
                ))}
            </div>
            {isOpaqueQrValue(q.value) ? (
              <>
                <p className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
                  {OPAQUE_QR_HELP}
                </p>
                <RawPayload value={q.value} />
              </>
            ) : fields.length > 0 ? (
              <>
                <table className="mt-1 w-full">
                  <tbody className="divide-y">
                    {fields.map(([label, value], j) => (
                      <tr key={j}>
                        <td className="py-1.5 pr-4 align-top font-medium text-gray-700 whitespace-nowrap">
                          {label}
                        </td>
                        <td className="py-1.5 break-all text-gray-600">{value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <RawPayload value={q.value} />
              </>
            ) : (
              <div className="mt-1 break-all text-gray-600">{rawPreview(q.value)}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
