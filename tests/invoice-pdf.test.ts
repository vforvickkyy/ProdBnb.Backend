import { describe, expect, it } from "vitest";
import { placeLabel } from "../src/modules/invoices/invoices.service";
import { amountInWords, inr, pdfSafe, renderPdf } from "../src/modules/invoices/pdf";

describe("invoice PDF helpers", () => {
  it("formats rupees the Indian way and in words", () => {
    expect(inr(123456750)).toBe("12,34,567.50");
    expect(inr(247800)).toBe("2,478.00");
    expect(amountInWords(247800)).toBe("Rupees Two Thousand Four Hundred Seventy Eight Only");
    expect(amountInWords(669060)).toBe("Rupees Six Thousand Six Hundred Ninety and Sixty Paise Only");
  });

  it("keeps PDF text to characters the font can draw", () => {
    expect(pdfSafe("₹500")).toBe("Rs. 500");
    expect(pdfSafe("10:00–12:00")).toBe("10:00–12:00"); // the en dash is in the font
  });

  it("doesn't repeat a city the listing title already names", () => {
    expect(placeLabel("Pine forest cottage in Chail", "Chail")).toBe("Pine forest cottage in Chail");
    expect(placeLabel("Sunlit loft", "Mumbai")).toBe("Sunlit loft, Mumbai");
    expect(placeLabel("Sunlit loft", null)).toBe("Sunlit loft");
  });

  it("renders a document with very long unbroken values", async () => {
    const pdf = await renderPdf({
      title: "TAX INVOICE",
      number: "INV/26-27/0001",
      date: "17 Nov 2026",
      seller: { name: "Co", lines: ["Somewhere"] },
      billedTo: { name: "Riya", lines: [] },
      details: [["Payment ref", "pb_demo_d_44f8f2d313194f979fb753639d6a2b1c0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4"]],
      lines: [{ description: "Booking", amount: 100000 }],
      totals: [{ label: "Total (INR)", amount: 100000, strong: true }],
      footer: "x",
    });
    expect(Buffer.from(pdf).subarray(0, 5).toString()).toBe("%PDF-");
  });
});
