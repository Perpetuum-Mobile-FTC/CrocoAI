const fs = require("fs");
const { TableLayoutType, Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ShadingType, AlignmentType, ImageRun, BorderStyle, HeadingLevel } = require("docx");

const GREEN = "2F7A40", SOFT = "EEF6E9", LINE = "BFBFBF", MUTED = "6B6B6B";
const W = 9638; // A4 text width with 2 cm margins (DXA)
const LABEL = 3000;
const border = { style: BorderStyle.SINGLE, size: 4, color: LINE };
const borders = { top: border, bottom: border, left: border, right: border };
const font = "Calibri";

const p = (text, opts = {}) => new Paragraph({ spacing: { after: opts.after ?? 60 }, children: [new TextRun({ text, font, size: opts.size || 21, bold: opts.bold, italics: opts.italics, color: opts.color })] });
const heading = (n, text) => new Paragraph({ spacing: { before: 260, after: 100 }, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: GREEN, space: 2 } },
  children: [new TextRun({ text: `${n}. ${text}`, font, size: 24, bold: true, color: GREEN })] });
const hint = (text) => p(text, { italics: true, color: MUTED, size: 18, after: 80 });

function row(label, lines = 1, help) {
  const fill = [];
  if (help) fill.push(new Paragraph({ children: [new TextRun({ text: help, font, size: 17, italics: true, color: MUTED })] }));
  for (let i = 0; i < lines; i++) fill.push(new Paragraph({ children: [new TextRun({ text: "", font, size: 21 })] }));
  return new TableRow({ children: [
    new TableCell({ width: { size: LABEL, type: WidthType.DXA }, borders, shading: { type: ShadingType.CLEAR, fill: SOFT, color: "auto" },
      margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [p(label, { bold: true, after: 0 })] }),
    new TableCell({ width: { size: W - LABEL, type: WidthType.DXA }, borders, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: fill }),
  ] });
}
const table = (rows) => new Table({ width: { size: W, type: WidthType.DXA }, layout: TableLayoutType.FIXED, columnWidths: [LABEL, W - LABEL], rows });

const box = (t) => `☐ ${t}`;
const logo = fs.readFileSync("process.env.LOGO || "../../../perpetuum-docs/branding/logo-perpetuum-mobile.png"");

const doc = new Document({
  creator: "Perpetuum Mobile #17870", title: "Fișă de activitate",
  sections: [{
    properties: { page: { margin: { top: 1000, bottom: 1000, left: 1134, right: 1134 } } },
    children: [
      new Table({ width: { size: W, type: WidthType.DXA }, layout: TableLayoutType.FIXED, borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE }, insideHorizontal: { style: BorderStyle.NONE }, insideVertical: { style: BorderStyle.NONE } }, columnWidths: [1500, W - 1500], rows: [new TableRow({ children: [
        new TableCell({ width: { size: 1500, type: WidthType.DXA }, borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [new Paragraph({ children: [new ImageRun({ type: "png", data: logo, transformation: { width: 70, height: 71 } })] })] }),
        new TableCell({ width: { size: W - 1500, type: WidthType.DXA }, borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          children: [
            p("Echipa FTC Perpetuum Mobile #17870", { size: 20, color: MUTED, after: 20 }),
            new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 20 }, children: [new TextRun({ text: "Fișă de activitate", font, size: 40, bold: true, color: GREEN })] }),
            p("Departamentul Non-Tehnic · propunere de activitate", { size: 20, color: MUTED, after: 0 }),
          ] }),
      ] })] }),
      hint("Completează fișa în Word (sau Google Docs), salveaz-o și încarc-o la tema „Idee de activitate” din platforma CrocoAI. Scrie concret: o idee bine descrisă poate fi aprobată și pusă în calendar."),

      heading(1, "Date generale"),
      table([row("Titlul activității"), row("Propusă de (nume, clasă)"), row("Data completării")]),

      heading(2, "Tipul activității"),
      p([box("Outreach (comunitate, școli, copii)"), box("Promovare / social media"), box("Strângere de fonduri")].join("     ")),
      p([box("Eveniment / workshop"), box("Recrutare"), box("Altul: ____________________")].join("     ")),

      heading(3, "Descrierea activității"),
      table([row("Pe scurt, ce facem?", 4, "3–5 propoziții: ce se întâmplă concret, pas cu pas.")]),

      heading(4, "Public țintă"),
      table([row("Cui se adresează?", 1, "ex. elevi de gimnaziu, părinți, comunitatea locală, firme"), row("Număr estimat de participanți")]),

      heading(5, "Obiective și impact"),
      table([
        row("Ce vrem să obținem?", 3),
        row("Legătura cu premiile FIRST", 2, "Inspire, Connect (comunitate, profesioniști STEM), Think (documentare), Motivate etc."),
      ]),

      heading(6, "Când și unde"),
      table([row("Data / perioada propusă"), row("Locul"), row("Durata")]),

      heading(7, "Echipa și responsabilități"),
      table([row("Câți membri sunt necesari?"), row("Cine ce face?", 3, "rol → persoană (ex. coordonare, materiale, foto, prezentare)"), row("Ajutor de la Departamentul Tehnic?", 1, "ex. demo cu robotul")]),

      heading(8, "Resurse și buget"),
      table([row("Materiale / echipamente", 2), row("Buget estimat (lei)"), row("Parteneri sau sponsori posibili", 2)]),

      heading(9, "Promovare"),
      table([row("Cum anunțăm activitatea?", 2, "canale: Instagram, TikTok, afișe, școală, presă locală")]),

      heading(10, "Riscuri"),
      table([row("Ce poate merge prost și cum prevenim?", 3)]),

      heading(11, "Cum măsurăm reușita"),
      table([row("Indicatori", 2, "ex. nr. participanți, distribuiri, fonduri strânse, feedback")]),

      heading(12, "Aprobări necesare"),
      p(box("Team Leader — participare / activitate în numele echipei (Art. 61.1)")),
      p(box("Mentor — dacă implică promisiuni față de sponsori sau parteneri (Art. 33.2)")),
      p(box("Conducerea școlii — pentru activități de recrutare în școală (Art. 52.2)")),
      p(box("Acord părinți — dacă implică deplasare (Art. 50, Anexa 14)")),
      hint("Bifează ce crezi că se aplică; Team Leader-ul confirmă la verificarea temei."),

      heading(13, "Observații"),
      table([row("Alte detalii", 3)]),
    ],
  }],
});
Packer.toBuffer(doc).then((b) => { fs.writeFileSync("fisa-de-activitate.docx", b); console.log("written", b.length); });
