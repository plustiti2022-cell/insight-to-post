"""Export the maintained design note as a two-page, selectable Chinese PDF."""
from pathlib import Path
import html
import re
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak
from pypdf import PdfReader

root = Path(__file__).resolve().parents[1]
destination = root / 'output' / 'pdf' / '设计决策说明-v02.pdf'
destination.parent.mkdir(parents=True, exist_ok=True)
pdfmetrics.registerFont(TTFont('YaHei', 'C:/Windows/Fonts/msyh.ttc'))
pdfmetrics.registerFont(TTFont('YaHeiBold', 'C:/Windows/Fonts/msyhbd.ttc'))
body = ParagraphStyle('Body', fontName='YaHei', fontSize=9.8, leading=15.5,
                      textColor=colors.HexColor('#27352f'), spaceAfter=7,
                      wordWrap='CJK')
heading = ParagraphStyle('Section', parent=body, fontName='YaHeiBold',
                         fontSize=11.8, leading=18, spaceBefore=7, spaceAfter=6,
                         keepWithNext=True, textColor=colors.HexColor('#176950'))
title = ParagraphStyle('Title', parent=heading, fontSize=20, leading=29,
                       spaceBefore=0, spaceAfter=10)

def markup(value):
    value = value.replace('–', '-').replace('—', '-')
    pieces = re.split(r'(\[[^\]]+\]\(https?://[^)]+\))', value)
    result = []
    for piece in pieces:
        match = re.fullmatch(r'\[([^\]]+)\]\((https?://[^)]+)\)', piece)
        if match:
            result.append(f'<link href="{html.escape(match[2], quote=True)}" color="#176950">{html.escape(match[1])}</link>')
        else:
            result.append(html.escape(piece.replace('`', '')))
    return ''.join(result)

text = (root / '设计决策说明.md').read_text(encoding='utf-8')
blocks = [block.strip() for block in text.split('\n\n') if block.strip()]
story = []
for block in blocks:
    if block.startswith('# '):
        story.append(Paragraph('Insight-to-Post', title))
        story.append(Paragraph('MVP 设计决策说明 · v0.2', heading))
    elif block.startswith('## '):
        if block.startswith('## 4.'):
            story.append(PageBreak())
        story.append(Paragraph(markup(block[3:]), heading))
    else:
        story.append(Paragraph(markup(block), body))

def decorate(canvas, document):
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor('#d7e5dd'))
    canvas.line(17*mm, 17*mm, A4[0]-17*mm, 17*mm)
    canvas.setFont('YaHei', 8)
    canvas.setFillColor(colors.HexColor('#607268'))
    canvas.drawString(17*mm, 12*mm, '2026-10-06 · 开发与浏览器验收通过，真手机待人工确认')
    canvas.drawRightString(A4[0]-17*mm, 12*mm, f'{document.page} / 2')
    canvas.restoreState()

document = SimpleDocTemplate(str(destination), pagesize=A4, leftMargin=17*mm,
                             rightMargin=17*mm, topMargin=17*mm, bottomMargin=24*mm,
                             title='Insight-to-Post MVP 设计决策说明 v0.2',
                             author='Insight-to-Post')
document.build(story, onFirstPage=decorate, onLaterPages=decorate)
reader = PdfReader(destination)
assert len(reader.pages) == 2, f'Expected two pages, got {len(reader.pages)}'
assert '全部文章的引用' in reader.pages[0].extract_text()
assert '社交文案与复制' in reader.pages[1].extract_text()
print(f'Design PDF verified: {len(reader.pages)} pages, selectable Chinese text.')
