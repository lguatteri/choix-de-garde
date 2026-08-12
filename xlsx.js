// ============================================================
// Générateur Excel (.xlsx) partagé — app assistée ET app auto.
// Écrit un classeur mono-feuille « Gardes » au format du document de
// référence, en JS pur : ZIP « stored » (sans compression) + CRC32 maison,
// aucune dépendance externe (compatible PWA hors-ligne).
//
// API publique : downloadGardesXlsx(dates, getRow, filename)
//   dates    : tableau de 'YYYY-MM-DD'
//   getRow(d): -> { gardeMondor, journeeMondor, gardeChenevier, journeeChenevier }
//              (chaînes, '' si vide). Astreinte/Après-midi restent vides.
//   filename : nom du fichier téléchargé
// ============================================================
(function (global) {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let crc = -1;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ -1) >>> 0;
  }
  function u16(n) { return [n & 0xff, (n >>> 8) & 0xff]; }
  function u32(n) { return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]; }
  // files: [{ name, data: Uint8Array }] → Uint8Array (archive ZIP)
  function buildZip(files) {
    const enc = new TextEncoder();
    const chunks = []; const central = []; let offset = 0;
    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data), size = f.data.length;
      const local = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0));
      chunks.push(Uint8Array.from(local), nameBytes, f.data);
      central.push(Uint8Array.from([].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0), u16(0),
        u16(0), u16(0), u32(0), u32(offset), Array.from(nameBytes))));
      offset += local.length + nameBytes.length + size;
    }
    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const end = Uint8Array.from([].concat(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralSize), u32(centralStart), u16(0)));
    const all = chunks.concat(central, [end]);
    let total = 0; for (const u of all) total += u.length;
    const out = new Uint8Array(total); let p = 0;
    for (const u of all) { out.set(u, p); p += u.length; }
    return out;
  }
  function xesc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function colLetter(i) { return String.fromCharCode(65 + i); }
  function cellStr(ref, val) {
    if (val === '' || val == null) return `<c r="${ref}"/>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xesc(val)}</t></is></c>`;
  }
  function cellDate(ref, serial) { return `<c r="${ref}" s="1"><v>${serial}</v></c>`; }
  // Numéro de série Excel (système 1900) pour une date 'YYYY-MM-DD'
  function excelSerial(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function downloadGardesXlsx(dates, getRow, filename) {
    const headers = ['Date', 'Après-midi Chenevier', 'Après-midi Mondor', 'Journée Chenevier',
      'Astreinte Mondor', 'Garde Mondor', 'Garde Chenevier', 'Journée Mondor', 'Astreinte Chenevier'];
    let rowsXml = '<row r="1">' + headers.map((h, i) => cellStr(colLetter(i) + '1', h)).join('') + '</row>';
    let rn = 2;
    for (const d of dates) {
      const r = getRow(d) || {};
      rowsXml += `<row r="${rn}">` +
        cellDate('A' + rn, excelSerial(d)) +          // Date
        cellStr('B' + rn, '') +                        // Après-midi Chenevier (non géré)
        cellStr('C' + rn, '') +                        // Après-midi Mondor    (non géré)
        cellStr('D' + rn, r.journeeChenevier || '') +  // Journée Chenevier
        cellStr('E' + rn, '') +                        // Astreinte Mondor     (non géré)
        cellStr('F' + rn, r.gardeMondor || '') +       // Garde Mondor
        cellStr('G' + rn, r.gardeChenevier || '') +    // Garde Chenevier
        cellStr('H' + rn, r.journeeMondor || '') +     // Journée Mondor
        cellStr('I' + rn, '') +                        // Astreinte Chenevier  (non géré)
        '</row>';
      rn++;
    }

    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<cols><col min="1" max="1" width="12" customWidth="1"/><col min="2" max="9" width="20" customWidth="1"/></cols>' +
      `<sheetData>${rowsXml}</sheetData></worksheet>`;
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts>' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '</styleSheet>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';
    const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Gardes" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '</Relationships>';

    const enc = new TextEncoder();
    const bytes = buildZip([
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rels) },
      { name: 'xl/workbook.xml', data: enc.encode(workbook) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
      { name: 'xl/styles.xml', data: enc.encode(styles) },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) },
    ]);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  global.downloadGardesXlsx = downloadGardesXlsx;
})(typeof window !== 'undefined' ? window : this);
