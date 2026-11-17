import fs from 'fs';
import path from 'path';

interface GraphEdge { to: string; fromCol: string; toCol: string; rel: string; }
interface GraphTable {
  name: string; label: string; ft?: string; parent?: string; rowCount: number;
  cols: Record<string, string>; colLabels: Record<string, string>; edges: GraphEdge[];
  _lbl?: string; _lblWords?: string[]; _colText?: string;
}
export interface TblMeta {
  name: string; label: string; ft?: string; parent?: string;
  children: Array<{ name: string; fk: string }>;
}

let catalog: TblMeta[] = [];
let schemaGraph: Record<string, GraphTable> | null = null;

const STOP_WORDS = new Set([
  'را','از','به','در','با','تا','بر','هر','چه','که','این','آن','هم','یا','اما','اگر','چون',
  'برای','چند','لیست','نشان','بده','بگو','کدام','چیست','چقدر','آخر','اخر','اخیر','جدید','کل',
  'همه','تعداد','مجموع','ترین','ثبت','شده','همراه','اساس','طبق','دارند','داشته','بوده','است',
  'اند','های','هایی','شان','شون','شرکت','سازمانی','مختلف','کامل','گزارش','مقایسه','شامل',
  'تفکیک','بیشترین','کمترین','بهترین','میزان','مبلغ','تحلیل','بررسی','چرا','علت','نمودار',
  'چارت','گراف','فهرست','تمام','همگی'
]);

const normText = (s: string) =>
  (s || '').replace(/\u200c/g, ' ').replace(/[ي]/g, 'ی').replace(/[ك]/g, 'ک').replace(/\s+/g, ' ').trim();

function loadGraph(): Record<string, GraphTable> {
  if (schemaGraph) return schemaGraph;
  const gp = path.join(process.cwd(), 'data/schema-graph.json');
  if (fs.existsSync(gp)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(gp, 'utf8'));
      schemaGraph = parsed.tables || {};
      for (const t of Object.values(schemaGraph!)) {
        t._lbl = normText(t.label || '');
        t._lblWords = t._lbl ? t._lbl.split(/\s+/) : [];
        t._colText = normText(Object.values(t.colLabels || {}).join(' '));
      }
      return schemaGraph!;
    } catch {}
  }
  return {};
}

function expandKeywords(q: string): string[] {
  const norm = normText(q).replace(/[؟?،,.:؛!()«»"'\d۰-۹]/g, ' ');
  const rawWords = norm.split(/\s+/).filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  const out = new Set<string>();
  const synMap: Record<string, string[]> = {
    'پرفروش': ['فروش', 'فاکتور', 'کالا'], 'کمفروش': ['فروش', 'فاکتور', 'کالا'],
    'فروش': ['فروش', 'فاکتور', 'کالا'], 'خرید': ['فروش', 'فاکتور', 'کالا', 'مشتری'],
    'محصول': ['کالا', 'فروش'], 'کالا': ['کالا', 'انبار'], 'مشتری': ['مشتری', 'فاکتور', 'تماس'],
    'حقوق': ['حقوق', 'فیش', 'کارمند'], 'کارمند': ['کارمند', 'حکم', 'تماس'],
    'پرسنل': ['کارمند', 'حکم', 'تماس'], 'کاربر': ['کاربر', 'شخص', 'تماس'],
    'یوزر': ['کاربر', 'شخص'], 'چک': ['چک', 'دریافتی', 'بانک'],
    'سند': ['سند', 'حسابداری', 'حساب'], 'قرارداد': ['قرارداد', 'کارفرمایی'],
    'دپارتمان': ['دپارتمان'], 'واحد': ['دپارتمان'], 'صفحه': ['صفحه', 'وب', 'سایت']
  };
  for (const w of rawWords) {
    const clean = w.replace(/(ترین|هایشان|هایی|های|شان|شون|ان|ها|ات|اش|ای|ی)$/g, '').trim();
    if (clean.length >= 2 && !STOP_WORDS.has(clean)) out.add(clean);
    if (!STOP_WORDS.has(w)) out.add(w);
    for (const [k, vals] of Object.entries(synMap)) {
      if (w.includes(k) || (clean.length >= 2 && clean.includes(k))) vals.forEach((v) => out.add(v));
    }
  }
  return [...out];
}

export function loadCatalog(): TblMeta[] {
  if (catalog.length > 0) return catalog;
  const g = loadGraph();
  catalog = Object.values(g).map((t) => ({ name: t.name, label: t.label, ft: t.ft, parent: t.parent, children: [] }));
  return catalog;
}

function findShortestJoinPaths(tables: string[], graph: Record<string, GraphTable>): string[] {
  if (tables.length < 2 || Object.keys(graph).length === 0) return [];
  const joins: string[] = [];
  const seenEdges = new Set<string>();
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i], b = tables[j], tA = graph[a];
      if (!tA) continue;
      const directEdges = (tA.edges || []).filter((e) => e.to === b);
      if (directEdges.length > 0) {
        for (const d of directEdges) {
          const k = [`${a}.${d.fromCol}`, `${b}.${d.toCol}`].sort().join('=');
          if (!seenEdges.has(k)) {
            seenEdges.add(k);
            const lbl = tA.colLabels?.[d.fromCol] || graph[b]?.colLabels?.[d.toCol] || '';
            joins.push(`${a}.${d.fromCol} = ${b}.${d.toCol}${lbl ? ` ("${lbl}")` : ''}`);
          }
        }
        continue;
      }
      for (const e1 of tA.edges || []) {
        const mid = graph[e1.to];
        const e2 = mid?.edges?.find((e) => e.to === b);
        if (e2 && (tables.includes(mid.name) || mid.name === 'gnd_egbse.tblPerson' || mid.name === 'gnd_egbse.tblContact')) {
          const pk = [a, b].sort().join('|');
          if (!seenEdges.has(pk)) {
            seenEdges.add(pk);
            joins.push(e1.fromCol === 'ID' && e1.toCol === 'ID' && e2.fromCol === 'ID' && e2.toCol === 'ID'
              ? `${a}.ID = ${b}.ID`
              : `${a}.${e1.fromCol} = ${mid.name}.${e1.toCol} AND ${mid.name}.${e2.fromCol} = ${b}.${e2.toCol}`);
          }
          break;
        }
      }
    }
  }
  return joins.slice(0, 12);
}

export function findRelevantTables(q: string): string[] {
  const normQ = normText(q);
  const graph = loadGraph();
  const words = expandKeywords(normQ);
  const out: string[] = [];
  const add = (n?: string) => { if (n && !out.includes(n) && out.length < 7) out.push(n); };

  const hasDate = /(?:^|[\s،,.:؛!؟?()])(سال|ماه|فصل|روز|روزهای|هفته|تاریخ|امسال|فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند|بهار|تابستان|پاییز|زمستان)(?:$|[\s،,.:؛!؟?()]|ها|های)/.test(normQ);
  const needsPerson = /(نام|اسم|مشتری|خریدار|فروشنده|کارشناس|کارمند|پرسنل|شخص|طرف|صادرکننده)/.test(normQ);
  const needsDept = /(دپارتمان|واحد|بخش)/.test(normQ);

  if (/(کاربر|کاربران|یوزر)/.test(normQ)) {
    add('gnd_egbse.tblUser');
    if (/(کارمند|کارمندان|پرسنل)/.test(normQ)) add('gnd_hrprs.tblEmployee');
    add('gnd_egbse.tblPerson'); add('gnd_egbse.tblContact');
  }
  if (/(صفحه|صفحات|وب سایت|وبسایت)/.test(normQ) || (normQ.includes('سایت') && !normQ.includes('بازدید'))) {
    add('gnd_grweb.tblPage'); add('gnd_grweb.tblWebSite');
  }
  if (normQ.includes('بازدید سایت') || (normQ.includes('بازدید') && normQ.includes('سایت'))) {
    add('gnd_grsup.tblSiteVisit'); add('gnd_hrprs.tblEmployee'); add('gnd_egbse.tblContact');
  }
  if (normQ.includes('گروه کالا') || normQ.includes('گروه های کالا')) {
    add('gnd_spgod.tblGoodGroup'); add('gnd_spgod.tblGood');
  }
  if (normQ.includes('حساب بانکی') || normQ.includes('حساب های بانکی')) {
    add('gnd_firpd.tblBankAccount'); add('gnd_firpd.tblBankBrand');
  }
  if ((normQ.includes('کالا') || normQ.includes('محصول')) && !/(فروش|پرفروش|فاکتور)/.test(normQ)) {
    add('gnd_spgod.tblGood'); add('gnd_spgod.tblGoodGroup');
  }
  if (/(دپارتمان|واحدهای سازمانی|واحد سازمانی)/.test(normQ)) add('gnd_egbse.tblDepartment');
  if (normQ.includes('طرف تماس') || normQ.includes('طرف های تماس') || (normQ.includes('تماس') && !normQ.includes('تلفن'))) add('gnd_egbse.tblContact');
  if (/(فروش|پرفروش|کمفروش|خرید|فاکتور)/.test(normQ)) {
    add('gnd_crsls.tblSalesInvoice'); add('gnd_crsls.tblSalesInvoiceDetail'); add('gnd_spgod.tblGood');
    if (/(مشتری|خریدار)/.test(normQ)) add('gnd_egbse.tblContact');
  }
  if (/(حقوق|فیش)/.test(normQ)) { add('gnd_hrpyr.tblSalaryBill'); add('gnd_hrprs.tblEmployee'); add('gnd_egbse.tblContact'); }
  if (/(کارمند|پرسنل)/.test(normQ)) { add('gnd_hrprs.tblEmployee'); add('gnd_egbse.tblContact'); }
  if (normQ.includes('چک')) { add('gnd_firpd.tblInputCheque'); add('gnd_firpd.tblBankBrand'); add('gnd_egbse.tblContact'); }

  if (normQ.includes('تنخواه')) {
    add('gnd_firpd.tblFundPayment');
    if (/(جزئیات|ردیف|شخص|اشخاص|بدهکار|حساب|مالیات|ارزش)/.test(normQ)) add('gnd_firpd.tblFundPaymentDetail');
    if (normQ.includes('حساب')) add('gnd_fiaci.tblAccount');
    if (/(شخص|اشخاص|بدهکار|نام)/.test(normQ)) add('gnd_egbse.tblContact');
  } else if (/(پرداخت\s*(?:های\s*)?نقد)/.test(normQ)) {
    add('gnd_firpd.tblCashPayment'); add('gnd_egbse.tblDepartment'); add('gnd_egbse.tblContact');
  } else if (/(پرداخت\s*(?:های\s*)?(?:بانکی|الکترونیک))/.test(normQ)) {
    add('gnd_firpd.tblElectronicPayment'); add('gnd_firpd.tblBankAccount'); add('gnd_egbse.tblContact');
  } else if (/(دریافت\s*(?:های\s*)?بانکی)/.test(normQ)) {
    add('gnd_firpd.tblBankInput'); add('gnd_firpd.tblBankAccount'); add('gnd_egbse.tblContact');
  } else if (normQ.includes('درخواست پرداخت') || normQ.includes('درخواست های پرداخت')) {
    add('gnd_firpd.tblPayRequest'); add('gnd_hrprs.tblEmployee'); add('gnd_egbse.tblDepartment'); add('gnd_egbse.tblContact');
  } else if (/(دریافت|پرداخت)/.test(normQ)) {
    add('gnd_firpd.tblCashReceive'); add('gnd_firpd.tblBankInput'); add('gnd_firpd.tblPayRequest');
  }

  if (/(سند|اسناد|حسابداری|بدهکار|بستانکار|آرتیکل)/.test(normQ) && !/(پرداخت|دریافت|چک|تنخواه)/.test(normQ)) {
    add('gnd_fiaci.tblTrans'); add('gnd_fiaci.tblTransDetail'); add('gnd_fiaci.tblAccount');
  }
  if (/(تردد|کارت ساعت|ورود و خروج|فراموش شده|تایم شیت|حضور و غیاب)/.test(normQ)) {
    if (normQ.includes('فراموش')) add('gnd_hrcio.tblForgottenEnterExit');
    if (normQ.includes('تایم')) add('gnd_hrcio.tblEmployeeTimeSheetDetail');
    add('gnd_hrcio.tblCardLog'); add('gnd_hrprs.tblEmployee'); add('gnd_egbse.tblContact');
  }
  if (/(درخواست خدمات|پشتیبانی|پیگیری خدمات)/.test(normQ) || (normQ.includes('خدمات') && !normQ.includes('قرارداد'))) {
    add('gnd_grsup.tblServiceRequest');
    if (/(پیگیری|جزئیات|زمان)/.test(normQ)) add('gnd_grsup.tblServiceRequestTrack');
    add('gnd_egbse.tblUser'); add('gnd_egbse.tblContact');
  }
  if (/(نامه|مکاتبات|دبیرخانه|صادره|داخلی)/.test(normQ)) {
    if (normQ.includes('داخلی')) add('gnd_ofsct.tblInternalLetter');
    add('gnd_ofsct.tblOutputLetter'); add('gnd_hrprs.tblEmployee'); add('gnd_egbse.tblContact');
  }
  if (normQ.includes('پیگیری فروش') || (normQ.includes('پیگیری') && !normQ.includes('خدمات') && !normQ.includes('بانک'))) {
    add('gnd_crflp.tblFollowUpStep'); add('gnd_hrprs.tblEmployee'); add('gnd_egbse.tblContact');
  }
  if (/(پروژه|قرارداد|پیمانکار)/.test(normQ)) {
    if (/(قرارداد|پیمانکار)/.test(normQ)) add('gnd_ficnt.tblOutsourceContract');
    add('gnd_pjprj.tblProject');
    if (needsDept) add('gnd_egbse.tblDepartment');
    if (needsPerson || normQ.includes('پیمانکار')) add('gnd_egbse.tblContact');
  }
  if (/(پیشنهاد\s*(?:های\s*)?قیمت|پروپوزال)/.test(normQ)) { add('gnd_crflp.tblProposal'); add('gnd_crflp.tblProposalDetail'); }
  if (normQ.includes('نقش')) add('gnd_egbse.tblRole');
  if (normQ.includes('پیغام')) add('gnd_ofofc.tblMessage');
  if (/(عضو|اعضا)/.test(normQ)) { add('gnd_egbse.tblContactMember'); add('gnd_egbse.tblContact'); }
  if (/(سمت|پست سازمانی|موقعیت سازمانی|موقعیت های سازمانی)/.test(normQ)) { add('gnd_egbse.tblPosition'); add('gnd_egbse.tblDepartment'); }

  const scored = Object.values(graph)
    .map((t) => {
      if (/DeleteLater|PracticeFormType|ApiLog|Survey/.test(t.name) && !normQ.includes('نظرسنجی')) return { t, s: 0 };
      let s = 0;
      const lbl = t._lbl || '', lblWords = t._lblWords || [], colTxt = t._colText || '';
      for (const w of words) {
        if (lbl === w) s += 50;
        else if (lblWords.includes(w)) s += 28;
        else if (w.length >= 3 && lbl.includes(w)) s += 12;
        if (w.length >= 3 && colTxt.includes(w)) s += 8;
      }
      if (s > 0) { if (t.ft) s += 5; if (t.rowCount > 0) s += 15; }
      return { t, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  for (const x of scored.slice(0, 5)) { add(x.t.name); if (x.t.parent) add(x.t.parent); }
  if (needsPerson) add('gnd_egbse.tblContact');
  if (needsDept) add('gnd_egbse.tblDepartment');
  if (hasDate) add('gnd_egbse.tblConvertDateTypeL');

  return out.length > 0 ? out.slice(0, 7) : ['gnd_crsls.tblSalesInvoice', 'gnd_crsls.tblSalesInvoiceDetail', 'gnd_spgod.tblGood'];
}

const FK_PRIORITY_RX = /^(ID|CredbCustomerID|DebitSalesManID|CredbEmployeeID|PayRequestEmployeeID|DepartmentID|CredbDepartmentID|CredbPersonID|BankBrandID|CreditAccountID|GoodID|GoodGroupID|SalesInvoiceID|WebsiteID|WriterUserID|ResponsibleEmployeeID|TransID|AccountID|EmployeeID|RequesterCustomerID|DoByUserID|ServiceRequestID|ReporterUserID|SenderEmployeeID|ReceiverContactID|RelatedContactID|DoneByEmployeeID|FollowUPID|DebitPersonID|CreditPersonID|DebitDepartmentID|CreditDepartmentID|CreditBankAccountID|CredbBankAccountID|CredbProjectID|CredbContractorID|FundPaymentID|ProposalID|PracticeSystemID|ContactID)$/i;
const DATA_PRIORITY_RX = /^(Code|GoodCode|EmployeeCode|AccountNumber|BankAccountName|ChequeNumber|Username|Farsi|Name|Title|Description|Mobile|OfficePhone|FatherName|EmploymentDate|DoneDate|ExecuteDate|PayRequestDate|PageDate|VisitDate|ChrisDate|ParsDate|ParsYear|ParsMonth|ParsMonthName|ParsDayName|DayOfWeek|Qty|UnitPrice|AccValue|SoldValue|TotalSoldValue|DetailTotal|DetailTotalAfterDiscount|TotalDiscount|DiscountValue|HoghugheMahiane|EzafeKar|Bahrevari|KasrKar|MaliateHoghugh|HagheBimeSahmKarmand|MandeGhabelePardakht|IsActive|IsRemoved|UniqePageName|CategoryID|PageStyleTypeID|VisibleLevelTypeID|IG|TransCode|DocDate|TotalDebit|TotalCredit|Debit|Credit|RowNumber|AccountCode|CardCode|DayDate|ClockTime|Notes|RequestStatus|SpentTime|ReslultComment|RequestDate|RequesterUserName|SystemName|FormTypeName|TotalSpendTimeCDUR|SpendTimeCDUR|StatusDate|SCDate|Subject|AssignCode|CallDate|NextStepDate|TotalValue|DocumentNumber|ReferenceNumber|BeginDate|EndDate|ContractCode|AccPercent|VatValue|MainCompanyUnitPrice|FirstName|LastName|Job|MobilePhone)$/i;

export async function getDynamicMcpContext(userQuestion: string) {
  const tables = findRelevantTables(userQuestion);
  const graph = loadGraph();
  const words = expandKeywords(userQuestion);
  console.log('🎯 Auto-Discovered Tables (up to 7 for Multi-Join):', tables);

  const joinPaths = findShortestJoinPaths(tables, graph);
  const structLines: string[] = [];
  if (joinPaths.length > 0) structLines.push('CERTIFIED JOIN PATHS: ' + joinPaths.join(' | '));
  structLines.push(
    'SQL RULES: 1) If gnd_egbse.tblContact c is joined with GROUP BY, ALWAYS include c.Farsi in BOTH SELECT and GROUP BY. 2) Put SUM/AVG/COUNT conditions in HAVING, never WHERE. 3) Salesman in tblSalesInvoice is DebitSalesManID (never SalesPersonID). Employee in tblSalaryBill is CredbEmployeeID (never PayRequestEmployeeID).'
  );

  for (const tbl of tables) {
    const gt = graph[tbl];
    if (gt && Object.keys(gt.cols).length > 0) {
      const allCols = Object.keys(gt.cols);
      const fkCols = allCols.filter((c) => FK_PRIORITY_RX.test(c) || (/ID$/i.test(c) && gt.edges.some((e) => e.fromCol === c && tables.includes(e.to))));
      const dataCols = allCols.filter((c) => !fkCols.includes(c) && (DATA_PRIORITY_RX.test(c) || words.some((w) => w.length >= 3 && (gt.colLabels[c] || '').includes(w))));
      const chosen = [...fkCols, ...dataCols].slice(0, 22);
      const formattedCols = (chosen.length > 0 ? chosen : allCols.slice(0, 18))
        .map((c) => (gt.colLabels[c] ? `${c}("${gt.colLabels[c]}")` : c))
        .join(', ');
      structLines.push(`[${tbl}] (${gt.label || 'جدول'} | rows=${gt.rowCount}) cols: ${formattedCols}`);
    } else {
      structLines.push(`[${tbl}] cols: ID, Name, Code, DoneDate, Description`);
    }
  }
  return {
    discoveredTables: tables,
    domainContext: '',
    tableStructContext: structLines.join('\n').slice(0, 2300),
    resolvedEntitiesPrompt: '',
    metadataContext: '',
  };
}
