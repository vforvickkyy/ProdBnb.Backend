import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";

/**
 * Invoice and receipt PDFs, drawn with pdf-lib's built-in Helvetica (pure JavaScript, nothing read
 * from disk, so it runs the same on Vercel). Helvetica covers Latin text only, so anything else in
 * a name or title is replaced and amounts are written "INR 1,234.00" (the rupee sign isn't in it).
 */
export interface PdfParty {
  name: string;
  lines: string[];
}

export interface PdfDocInput {
  title: string;
  number: string | null;
  date: string;
  seller: PdfParty;
  billedTo: PdfParty;
  details: [string, string][];
  lines: { description: string; sac?: string | null; amount: number; negative?: boolean }[];
  totals: { label: string; amount: number; strong?: boolean; negative?: boolean }[];
  amountInWords?: string | null;
  notes?: string | null;
  terms?: string | null;
  footer: string;
  signatory?: string | null;
}

const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";

/** Keeps what Helvetica can print; swaps the rupee sign and smart quotes; replaces the rest. */
export function pdfSafe(text: string): string {
  return Array.from(text.replace(/₹/g, "Rs. ").replace(/[‘’]/g, "'").replace(/[“”]/g, '"'))
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) return ch;
      if (ch === "\n") return "\n";
      return "?";
    })
    .join("");
}

/** 1234567.5 rupees as "12,34,567.50" (Indian grouping). */
export function inr(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100).toString();
  const paise = String(abs % 100).padStart(2, "0");
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}${grouped}.${paise}`;
}

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
function under1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const tens = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ` ${ONES[r % 10]}` : ""}`;
  return [h ? `${ONES[h]} Hundred` : "", tens].filter(Boolean).join(" ");
}

/** "Rupees Twelve Lakh Thirty-Four Thousand ... and Fifty Paise Only" (Indian numbering). */
export function amountInWords(minor: number): string {
  const rupees = Math.floor(Math.abs(minor) / 100);
  const paise = Math.abs(minor) % 100;
  const parts: string[] = [];
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const rest = rupees % 1000;
  if (crore) parts.push(`${under1000(crore)} Crore`);
  if (lakh) parts.push(`${under1000(lakh)} Lakh`);
  if (thousand) parts.push(`${under1000(thousand)} Thousand`);
  if (rest) parts.push(under1000(rest));
  const words = parts.length ? parts.join(" ") : "Zero";
  return `Rupees ${words}${paise ? ` and ${under1000(paise)} Paise` : ""} Only`;
}

const INK = rgb(0.11, 0.1, 0.09);
const MUTED = rgb(0.42, 0.4, 0.38);
const LINE = rgb(0.88, 0.86, 0.85);
const FILL = rgb(0.97, 0.96, 0.95);

class Writer {
  page: PDFPage;
  y: number;
  constructor(
    private doc: PDFDocument,
    private font: PDFFont,
    private bold: PDFFont,
  ) {
    this.page = doc.addPage([595.28, 841.89]);
    this.y = 841.89 - 48;
  }
  readonly left = 48;
  readonly right = 595.28 - 48;

  ensure(space: number) {
    if (this.y - space < 60) {
      this.page = this.doc.addPage([595.28, 841.89]);
      this.y = 841.89 - 48;
    }
  }

  wrap(text: string, size: number, width: number, font = this.font): string[] {
    const out: string[] = [];
    for (const para of pdfSafe(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= width) line = next;
        else {
          if (line) out.push(line);
          line = word;
        }
      }
      out.push(line);
    }
    return out;
  }

  text(t: string, x: number, y: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; align?: "left" | "right"; width?: number } = {}) {
    const font = opts.bold ? this.bold : this.font;
    const safe = pdfSafe(t);
    const w = font.widthOfTextAtSize(safe, size);
    const dx = opts.align === "right" ? x - w : x;
    this.page.drawText(safe, { x: dx, y, size, font, color: opts.color ?? INK });
  }

  hr(y = this.y) {
    this.page.drawLine({ start: { x: this.left, y }, end: { x: this.right, y }, thickness: 0.7, color: LINE });
  }
}

export async function renderPdf(input: PdfDocInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${input.title}${input.number ? ` ${input.number}` : ""}`));
  doc.setCreator(pdfSafe(input.seller.name));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold);

  // Header: seller (left), title + number + date (right).
  w.text(input.seller.name, w.left, w.y, 16, { bold: true });
  w.text(input.title, w.right, w.y, 16, { bold: true, align: "right" });
  let ly = w.y - 16;
  for (const l of input.seller.lines) {
    for (const part of w.wrap(l, 9, 280)) {
      w.text(part, w.left, ly, 9, { color: MUTED });
      ly -= 12;
    }
  }
  let ry = w.y - 18;
  if (input.number) {
    w.text(`No. ${input.number}`, w.right, ry, 10, { bold: true, align: "right" });
    ry -= 14;
  }
  w.text(`Date: ${input.date}`, w.right, ry, 10, { align: "right" });
  w.y = Math.min(ly, ry) - 14;
  w.hr();
  w.y -= 20;

  // Billed to (left) and booking details (right).
  const top = w.y;
  w.text("BILLED TO", w.left, w.y, 8, { bold: true, color: MUTED });
  w.y -= 14;
  w.text(input.billedTo.name, w.left, w.y, 11, { bold: true });
  w.y -= 13;
  for (const l of input.billedTo.lines) {
    for (const part of w.wrap(l, 9, 250)) {
      w.text(part, w.left, w.y, 9, { color: MUTED });
      w.y -= 12;
    }
  }
  const leftEnd = w.y;
  let dy = top;
  const dx = 320;
  w.text("DETAILS", dx, dy, 8, { bold: true, color: MUTED });
  dy -= 14;
  for (const [label, value] of input.details) {
    w.text(label, dx, dy, 9, { color: MUTED });
    const lines = w.wrap(value, 9, w.right - (dx + 92));
    lines.forEach((part, i) => w.text(part, dx + 92, dy - i * 11, 9));
    dy -= 11 * lines.length + 3;
  }
  w.y = Math.min(leftEnd, dy) - 16;

  // Line items.
  w.ensure(60);
  w.page.drawRectangle({ x: w.left, y: w.y - 6, width: w.right - w.left, height: 20, color: FILL });
  w.text("DESCRIPTION", w.left + 8, w.y, 8, { bold: true, color: MUTED });
  w.text("SAC", 400, w.y, 8, { bold: true, color: MUTED });
  w.text("AMOUNT (INR)", w.right - 8, w.y, 8, { bold: true, color: MUTED, align: "right" });
  w.y -= 24;
  for (const line of input.lines) {
    const desc = w.wrap(line.description, 10, 330);
    w.ensure(14 * desc.length + 8);
    desc.forEach((part, i) => w.text(part, w.left + 8, w.y - i * 13, 10));
    if (line.sac) w.text(line.sac, 400, w.y, 10);
    w.text(`${line.negative ? "- " : ""}${inr(line.amount)}`, w.right - 8, w.y, 10, { align: "right" });
    w.y -= 13 * desc.length + 8;
    w.hr(w.y + 4);
    w.y -= 6;
  }

  // Totals.
  w.y -= 4;
  for (const t of input.totals) {
    w.ensure(18);
    w.text(t.label, 380, w.y, t.strong ? 11 : 10, { bold: t.strong, color: t.strong ? INK : MUTED, align: "right" });
    w.text(`${t.negative ? "- " : ""}${inr(t.amount)}`, w.right - 8, w.y, t.strong ? 11 : 10, { bold: t.strong, align: "right" });
    w.y -= t.strong ? 18 : 15;
  }
  if (input.amountInWords) {
    w.y -= 4;
    for (const part of w.wrap(`Amount in words: ${input.amountInWords}`, 9, w.right - w.left)) {
      w.ensure(12);
      w.text(part, w.left, w.y, 9, { color: MUTED });
      w.y -= 12;
    }
  }

  // Notes, terms, signatory, footer.
  for (const [heading, body] of [
    ["Notes", input.notes],
    ["Terms", input.terms],
  ] as const) {
    if (!body) continue;
    w.y -= 14;
    w.ensure(30);
    w.text(heading.toUpperCase(), w.left, w.y, 8, { bold: true, color: MUTED });
    w.y -= 12;
    for (const part of w.wrap(body, 9, w.right - w.left)) {
      w.ensure(12);
      w.text(part, w.left, w.y, 9, { color: MUTED });
      w.y -= 12;
    }
  }
  if (input.signatory) {
    w.y -= 24;
    w.ensure(30);
    w.text(`For ${input.seller.name}`, w.right, w.y, 9, { align: "right", color: MUTED });
    w.y -= 14;
    w.text(input.signatory, w.right, w.y, 10, { bold: true, align: "right" });
    w.y -= 12;
    w.text("Authorised signatory", w.right, w.y, 8, { align: "right", color: MUTED });
  }
  for (const page of doc.getPages()) {
    const footer = pdfSafe(input.footer);
    page.drawText(footer, { x: 48, y: 30, size: 8, font, color: MUTED });
  }
  return doc.save();
}
