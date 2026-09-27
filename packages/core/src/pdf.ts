import { formatINR, romanize, type Paise } from "@dentalos/shared";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * Small helpers shared by our PDFs (estimates, receipts, invoices). The built-in PDF fonts only have Latin
 * letters, so Hindi is written in English letters (ASSUMPTIONS A-40) and ₹ becomes "Rs.".
 */
export const pdfText = (s: string) =>
  romanize(s)
    .replace(/₹/g, "Rs. ")
    .replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "")
    .trim();

export const pdfRupees = (paise: number) => formatINR(paise as Paise).replace("₹", "Rs. ");

export interface PdfWriter {
  pdf: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  y: number;
  text(s: string, x: number, size?: number, f?: PDFFont, muted?: boolean): void;
  right(s: string, xRight: number, size?: number, f?: PDFFont): void;
  line(): void;
  down(by: number): void;
}

/** An A4 page with a cursor that moves down, and the clinic's letterhead. */
export async function a4(title: string): Promise<PdfWriter> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setProducer("Sentio Dental OS");
  const page = pdf.addPage([595, 842]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.1, 0.12, 0.15);
  const grey = rgb(0.4, 0.44, 0.5);
  const w: PdfWriter = {
    pdf,
    page,
    font,
    bold,
    y: 790,
    text(s, x, size = 11, f = font, muted = false) {
      page.drawText(pdfText(s), { x, y: w.y, size, font: f, color: muted ? grey : ink });
    },
    right(s, xRight, size = 11, f = font) {
      const t = pdfText(s);
      page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y: w.y, size, font: f, color: ink });
    },
    line() {
      page.drawLine({ start: { x: 50, y: w.y }, end: { x: 545, y: w.y }, thickness: 0.5, color: grey });
    },
    down(by) {
      w.y -= by;
    },
  };
  return w;
}

export interface Letterhead {
  name: string;
  legalName?: string | null;
  address?: string | null;
  phone?: string | null;
  gstin?: string | null;
}

export function letterhead(w: PdfWriter, c: Letterhead) {
  w.text(c.name, 50, 18, w.bold);
  w.down(18);
  if (c.legalName && c.legalName !== c.name) {
    w.text(c.legalName, 50, 10, w.font, true);
    w.down(14);
  }
  if (c.address) {
    w.text(c.address.slice(0, 95), 50, 10, w.font, true);
    w.down(14);
  }
  const contact = [c.phone ? `Phone: ${c.phone}` : null, c.gstin ? `GSTIN: ${c.gstin}` : null]
    .filter(Boolean)
    .join("   ");
  if (contact) {
    w.text(contact, 50, 10, w.font, true);
    w.down(14);
  }
  w.down(20);
}
