"""Small dependency-free report exports; no templates or fonts are copied."""
import io
import zipfile
from xml.sax.saxutils import escape


def export_report(data, kind):
    s=data["summary"]
    lines=["AI R&D Efficiency — Fictional Demo", f"UTC: {data['range']['start']} to {data['range']['end']}",
           "All built-in companies, projects and metrics are fictional.",
           f"Projects: {s['monitor_project_count']}",f"Added lines (known): {s['added_lines']}",
           f"Input tokens: {s['prompt_tokens']}",f"Output tokens: {s['completion_tokens']}",
           f"Total tokens: {s['total_tokens']}",f"API requests: {s['request_count']}",f"Commits: {s['commit_count']}",
           "Token and code ratios do not demonstrate causal productivity gains.","Project added-line ranking:"]
    for p in data["project_code_ranking"]:
        # PDF uses stable numerical IDs, avoiding an embedded third-party font.
        name=p["project_name"] if kind=="docx" else f"Demo project #{p['project_id']}"
        lines.append(f"{name}: {p['value']} lines")
    if kind=="docx":
        paragraphs=''.join(f'<w:p><w:r><w:t xml:space="preserve">{escape(line)}</w:t></w:r></w:p>' for line in lines)
        out=io.BytesIO()
        with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
            z.writestr('[Content_Types].xml','<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
            z.writestr('_rels/.rels','<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
            z.writestr('word/document.xml',f'<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>')
        return out.getvalue()
    if kind!='pdf': raise ValueError('报告格式需为 pdf 或 docx')
    # ASCII PDF with standard Helvetica: portable, no bundled font assets.
    lines=[line.replace('—','-') for line in lines]
    pages=[lines[i:i+40] for i in range(0,len(lines),40)]
    objects=[b'<< /Type /Catalog /Pages 2 0 R >>',b'',b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    page_ids=[]
    for page in pages:
        page_id=len(objects)+1; stream_id=page_id+1; page_ids.append(page_id)
        commands=['BT /F1 11 Tf 16 TL 48 790 Td']
        for i,line in enumerate(page):
            text=line.encode('ascii','replace').decode().replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
            commands.append(('T* ' if i else '')+f'({text}) Tj')
        stream=('\n'.join(commands)+'\nET').encode()
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents {stream_id} 0 R >>'.encode())
        objects.append(f'<< /Length {len(stream)} >>\nstream\n'.encode()+stream+b'\nendstream')
    objects[1]=f"<< /Type /Pages /Kids [{' '.join(f'{i} 0 R' for i in page_ids)}] /Count {len(page_ids)} >>".encode()
    out=bytearray(b'%PDF-1.4\n'); offsets=[0]
    for i,obj in enumerate(objects,1):
        offsets.append(len(out)); out.extend(f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n')
    xref=len(out); out.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
    for offset in offsets[1:]: out.extend(f'{offset:010d} 00000 n \n'.encode())
    out.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    return bytes(out)
