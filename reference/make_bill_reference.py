from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont('R','/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf'))
pdfmetrics.registerFont(TTFont('B','/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'))
pdfmetrics.registerFont(TTFont('I','/usr/share/fonts/truetype/liberation/LiberationSans-BoldItalic.ttf'))
pdfmetrics.registerFont(TTFont('D','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'))
W,H=A4; c=canvas.Canvas('sample_bill.pdf',pagesize=A4)
L,R=40,W-40; c.setLineWidth(0.6)
def t(x,y,s,f='R',sz=8.5): c.setFont(f,sz); c.drawString(x,y,s)
def tr(x,y,s,f='R',sz=8.5): c.setFont(f,sz); c.drawRightString(x,y,s)
def tc(x,y,s,f='R',sz=8.5): c.setFont(f,sz); c.drawCentredString(x,y,s)
def ln(x1,y1,x2,y2): c.line(x1,y1,x2,y2)
lg_h=60; lw,lh=__import__('PIL.Image',fromlist=['x']).open(__import__('os').path.join(__import__('os').path.dirname(__file__),'logo.png')).size; lg_w=lg_h*lw/lh
c.drawImage(__import__('os').path.join(__import__('os').path.dirname(__file__),'logo.png'),W/2-lg_w/2,H-28-lg_h,lg_w,lg_h)
tc(W/2,H-28-lg_h-16,'Tax Invoice','B',11)
top=H-28-lg_h-20; mid=300
# header box
hb=top-92; c.rect(L,hb,R-L,top-hb)
ln(mid,top,mid,hb-0); ln(mid,top-28,R,top-28); ln(430,top,430,top-28)
y=top-11
for s,f in [('S.R. Jewellers','B'),('Lal Kuan, Sarrafa  Bazar','R'),('Bulandshahr','R'),('GSTIN/UIN: 09AIPPV2929L1ZB','R'),('State Name :  Uttar Pradesh, Code : 09','R'),('Contact : 9760012800','R')]:
    t(L+3,y,s,f); y-=13
t(mid+3,top-10,'Invoice No.','R',7.5); t(mid+3,top-22,'SR/WEB/301','B')
t(433,top-10,'Dated','R',7.5); t(433,top-22,'10-Oct-26','B')
# buyer
bb=hb-90; c.rect(L,bb,mid-L,hb-bb)
t(L+3,hb-10,'Buyer (Bill to)','R',7.5); t(L+3,hb-23,'Shruti Mohan Uniyal D/o Sanjay Mohan Uniyal','B',9)
yy=hb-35
for s_ in ['House No 132, Jhanda Moholla,','Dehradun, Uttarakhand - 248001','Phone No:- 7060329291','State Name          : Uttarakhand, Code : 05','Place of Supply   : Uttar Pradesh']:
    t(L+3,yy,s_); yy-=11
ln(mid,hb,mid,bb); ln(mid,bb,R,bb)
# items table
cols=[L,58,250,300,365,430,455,R]
th=bb; tb=th-275; c.rect(L,tb,R-L,th-tb)
for x in cols[1:-1]: ln(x,th,x,tb+18)
ln(L,th-22,R,th-22)
hdr=['Sl\nNo.','Description of Goods','HSN/SAC','Quantity','Rate','per','Amount']
for i,h in enumerate(hdr):
    cx=(cols[i]+cols[i+1])/2; parts=h.split('\n')
    for j,p in enumerate(parts): tc(cx,th-10-j*9,p,'R',7.5)
y=th-36
t(L+5,y,'1'); t(62,y,'Gold Ring 22kt','B'); t(253,y,'7113'); tr(cols[4]-3,y,'0.550 Grm','B')
tr(cols[5]-3,y,'13,900.00'); t(433,y,'Grm'); tr(R-3,y,'7,645.00','B')
y-=12; c.setFont('Helvetica-Oblique',8); c.drawString(72,y,'Making Charges@10%'); tr(R-3,y,'764.50','B')
y-=18; ln(455,y+8,R,y+8); tr(R-3,y-2,'8,409.50')
y-=20
for lab,v in [('C-Gst','126.14'),('S-Gst','126.14'),('Round Off','0.22')]:
    tr(cols[2]-5,y,lab,'I'); tr(R-3,y,v,'B'); y-=12
c.setFont('Helvetica-Oblique',8); c.drawString(62,y+12,'Add :')
ln(L,tb+18,R,tb+18)
tr(cols[3]-5,tb+6,'Total'); tr(cols[4]-3,tb+6,'0.550 Grm','B'); tr(R-3,tb+5,'₹ 8,662.00','D',10)
# words
y=tb-10; t(L+3,y,'Amount Chargeable (in words)','R',7.5); c.setFont('Helvetica-Oblique',7.5); c.drawRightString(R-3,y,'E. & O.E')
t(L+3,y-12,'INR Eight Thousand Six Hundred Sixty Two Only','B',9)
# tax table
ty=y-20; tyb=ty-58; c.rect(L,tyb,R-L,ty-tyb)
tc_=[L,200,260,290,345,375,430,R]
for i,x in enumerate(tc_[1:-1],1): ln(x,ty-12 if i in (3,5) else ty,x,tyb)
ln(tc_[2],ty-12,tc_[6],ty-12); ln(L,ty-24,R,ty-24); ln(L,ty-38,R,ty-38)
tc(120,ty-15,'HSN/SAC','R',7.5); tc(230,ty-9,'Taxable','R',7.5); tc(230,ty-20,'Value','R',7.5)
tc(317,ty-9,'CGST','R',7.5); tc(402,ty-9,'SGST/UTGST','R',7.5)
for x,s in [(275,'Rate'),(317,'Amount'),(360,'Rate'),(402,'Amount')]: tc(x,ty-21,s,'R',7.5)
tc((430+R)/2,ty-9,'Total','R',7.5); tc((430+R)/2,ty-20,'Tax Amount','R',7.5)
r=ty-34; t(L+3,r,'7113','R',7.5)
for x,s in [(257,'8,409.50'),(288,'1.50%'),(342,'126.14'),(373,'1.50%'),(427,'126.14'),(R-3,'252.28')]: tr(x,r,s,'R',7.5)
r=ty-50; tr(197,r,'Total','B',7.5)
for x,s in [(257,'8,409.50'),(342,'126.14'),(427,'126.14'),(R-3,'252.28')]: tr(x,r,s,'B',7.5)
# footer
y=tyb-14; t(L+3,y,'Tax Amount (in words)  :','R',7.5); t(160,y,'INR Two Hundred Fifty Two and Twenty Eight paise Only','B',9)
fb=y-95; c.rect(L,fb,R-L,y+8-fb)
bx=270; y2=y-14
t(bx,y2,"Company's Bank Details",'R',7.5)
for lab,v in [("A/c Holder's Name",'S.R. Jewellers'),('Bank Name','IndusInd Bank C/a A/c No:- 259760012801'),('A/c No.','259760012801'),('Branch & IFS Code','D.M. Road, Bsr & INDB0002099')]:
    y2-=10; t(bx,y2,lab,'R',7.5); t(bx+75,y2,':  '+v,'B',7.5)
t(L+3,fb+38,"Company’s PAN",'R',7.5); t(140,fb+38,':  AIPPV2929L','B',7.5)
ln(bx-3,fb+30,R,fb+30); ln(bx-3,fb,bx-3,fb+30)
c.setFont('R',7); c.drawString(L+3,fb+26,'Declaration')
for i,s in enumerate(['We declare that this invoice shows the actual price of','the goods described and that all particulars are true','and correct.']): t(L+3,fb+17-i*8,s,'R',7.5)
tr(R-3,fb+21,'for S.R. Jewellers','B',7.5); tr(R-3,fb+4,'Authorised Signatory','R',7)
tc(W/2,fb-14,'This is a Computer Generated Invoice','R',8)
c.save()
