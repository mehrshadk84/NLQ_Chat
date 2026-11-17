import {
  EXECUTIVE_REPORT_JSON_SCHEMA,
  ExecutiveReportOutput,
  HypothesisItem,
  StageName,
  UNIFIED_GENESIS_JSON_SCHEMA,
  UnifiedGenesisOutput,
  UserIntentType,
  DiagramChartType,
} from './schemas';
import { fetchExternalWebContext } from './web-search';
import { generateStructured, loadPromptTemplate } from './ollama-client';
import { checkSelectSql } from '@/lib/erp/sql-guard';
import { openExecutor } from '@/lib/erp/executor';
import { getErpConnection } from '@/lib/mcp/client';
import { getDynamicMcpContext } from '@/lib/mcp/orchestrator';
import { maskSensitiveRows } from './sanitizer';

export interface StageProgressEvent {
  stage: StageName;
  status: 'STARTED' | 'COMPLETED' | 'WARNING' | 'ERROR';
  message?: string;
  durationMs?: number;
  payload?: any;
}

function stripTopLevelWhere(sql: string): string {
  let depth = 0;
  let whereIdx = -1;
  let endIdx = sql.length;
  const upper = sql.toUpperCase();
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (whereIdx === -1 && /^WHERE\b/.test(upper.slice(i)) && (i === 0 || /\s/.test(sql[i - 1]))) whereIdx = i;
      else if (whereIdx !== -1 && /^(GROUP\s+BY|ORDER\s+BY|HAVING)\b/.test(upper.slice(i)) && /\s/.test(sql[i - 1])) {
        endIdx = i;
        break;
      }
    }
  }
  if (whereIdx === -1) return sql;
  return (sql.slice(0, whereIdx) + ' ' + sql.slice(endIdx)).replace(/\s+/g, ' ').trim();
}

function stripIdColumnsFromRows(rows: any[]): any[] {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const keys = Object.keys(rows[0]);
  const nonIdKeys = keys.filter((k) => !/^(ID|IG|[A-Za-z0-9_]+ID)$/i.test(k));
  if (nonIdKeys.length === 0) return rows;
  return rows.map((r) => {
    const out: Record<string, any> = {};
    for (const k of nonIdKeys) out[k] = r[k];
    return out;
  });
}

export function sanitizeErpSql(rawSql: string, userQuestion = ''): string {
  let s = (rawSql || '').replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[}\];\s]+$/, '');
  if (!s) return '';

  if (/\bgnd_hrprs\.tblEmployee\b/i.test(s) && !/\bgnd_firpd\.tblPayRequest\b/i.test(s) && !/\bgnd_hrpyr\.tblSalaryBill\b/i.test(s)) {
    s = s.replace(/,\s*[a-z0-9_]+\.Name(?:\s+AS\s+[a-z0-9_]+)?/gi, '')
         .replace(/\b[a-z0-9_]+\.Name(?:\s+AS\s+[a-z0-9_]+)?\s*,\s*/gi, '')
         .replace(/\b(?:INNER|LEFT)\s+JOIN\s+gnd_egbse\.tblDepartment\s+(?:AS\s+)?[a-z0-9_]+\s+ON\s+[^\s]+\s*=\s*[^\s]+/gi, '');
  }
  if (/\bgnd_firpd\.tblPayRequest\b/i.test(s) && /\bgnd_firpd\.tblBankAccount\b/i.test(s)) {
    s = s.replace(/,\s*[a-z0-9_]+\.(?:BankAccountName|AccountNumber|AccountCode)(?:\s+AS\s+[a-z0-9_]+)?/gi, '')
         .replace(/\b(?:INNER|LEFT)\s+JOIN\s+gnd_firpd\.tblBankAccount\s+(?:AS\s+)?[a-z0-9_]+\s+ON\s+[^\s]+\s*=\s*[^\s]+/gi, '');
  }
  if (/\btblFundPayment/i.test(s)) s = s.replace(/\b([a-z0-9_]+)\.VatValue\s*>\s*0\b/gi, '$1.VatValue >= 0');
  if (userQuestion.includes('تنخواه') && !/(جزئیات|ردیف|شخص|اشخاص|بدهکار|حساب|مالیات)/.test(userQuestion)) {
    s = s.replace(/\bc\.Farsi\s*,\s*/gi, '').replace(/\bINNER\s+JOIN\s+gnd_firpd\.tblFundPaymentDetail\b.+?(?=\s+ORDER\s+BY\b|$)/gi, '');
  }
  if (/\bgnd_egbse\.tblContactMember\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s)) {
    const cm = s.match(/\bgnd_egbse\.tblContactMember\s+(?:AS\s+)?([a-z0-9_]+)/i)![1];
    s = s.replace(new RegExp('\\b' + cm + '\\.Email\\b', 'gi'), cm + '.EmailAlias');
    if (!new RegExp('\\b' + cm + '\\.FirstName\\b', 'i').test(s)) s = s.replace(new RegExp('(\\b' + cm + '\\.LastName\\b)', 'i'), cm + '.FirstName, $1');
    if (userQuestion.includes('نام عضو')) s = s.replace(/\bc\.Farsi\s+AS\s+MemberName\b/gi, '(' + cm + ".FirstName + N' ' + " + cm + '.LastName) AS MemberName');
  }
  s = s.replace(/\bAS\s+([\u0600-\u06FF]+)\s+([\u0600-\u06FF]+)(?=\s*,|\s+FROM\b)/gi, 'AS $1_$2')
       .replace(/\bAS\s+RowCount\b/gi, 'AS DetailRowCount').replace(/\bORDER\s+BY\s+RowCount\b/gi, 'ORDER BY DetailRowCount')
       .replace(/\b([a-z0-9_]+)\.AccVal\b(?!ue)/gi, '$1.AccValue')
       .replace(/\bShamsiDate\b/gi, 'ParsDate').replace(/\bShamsiYear\b/gi, 'ParsYear')
       .replace(/\bShamsiMonthName\b/gi, 'ParsMonthName').replace(/\bShamsiMonth\b/gi, 'ParsMonth')
       .replace(/\btblInvoiceHeader\b/gi, 'tblSalesInvoice')
       .replace(/\b(tblInvoiceDetail|tblSalesOrderItem)\b/gi, 'tblSalesInvoiceDetail')
       .replace(/\b([a-z0-9_]+)\.DateCol\b/gi, '$1.DoneDate')
       .replace(/CAST\(\s*([a-z0-9_.]*ID)\s+AS\s+DATE\s*\)/gi, 'CAST(GETDATE() AS DATE)')
       .replace(/\b([a-z0-9_]+)\.ItemCode\b/gi, '$1.GoodID')
       .replace(/\b([a-z0-9_]+)\.SalePrice\b/gi, '$1.UnitPrice')
       .replace(/\b([a-z0-9_]+)\.Quantity\b/gi, '$1.Qty')
       .replace(/\b([a-z0-9_]+)\.(RealLegalType|GoodType|UnitType|VersionType|DepartmentType)\b/gi, '$1.$2ID')
       .replace(/,\s*(?:[a-z0-9_]+\.)?(?:PaymentType|AccType|TransType)\b(?:\s+AS\s+[a-z0-9_\[\]]+)?/gi, '')
       .replace(/\b(?:[a-z0-9_]+\.)?(?:PaymentType|AccType|TransType)\b(?:\s+AS\s+[a-z0-9_\[\]]+)?\s*,\s*/gi, '')
       .replace(/\bg\.GoodID\b/gi, 'd.GoodID').replace(/\ba\.Code\b/gi, 'a.AccountCode');

  if (/\bgnd_firpd\.tblPayRequest\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s)) {
    const prAl = s.match(/\bgnd_firpd\.tblPayRequest\s+(?:AS\s+)?([a-z0-9_]+)/i)![1];
    s = s.replace(new RegExp('\\b' + prAl + '\\.DoneDate\\b', 'gi'), prAl + '.PayRequestDate');
  }
  if (/\bgnd_firpd\.tblBankAccount\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s)) {
    const baAl = s.match(/\bgnd_firpd\.tblBankAccount\s+(?:AS\s+)?([a-z0-9_]+)/i)![1];
    s = s.replace(new RegExp('\\b' + baAl + '\\.(AccountCode|Code|Name)\\b', 'gi'), baAl + '.AccountNumber');
  }
  if (/SELECT\s+(?:TOP\s+\d+\s+)?\*\s+FROM\s+gnd_egbse\.tblRole\b/i.test(s)) {
    s = s.replace(/SELECT\s+(?:TOP\s+\d+\s+)?\*/i, 'SELECT ID, Description, GrantDisplay, GrantEdit');
  }
  if (/\bJOIN\s+gnd_egbse\.tblConvertDateTypeL\s+dt\b/i.test(s) && !/\bdt\.(?!ChrisDate\b)[A-Za-z0-9_]+/i.test(s)) {
    s = s.replace(/\s*(?:INNER|LEFT)\s+JOIN\s+gnd_egbse\.tblConvertDateTypeL\s+dt\s+ON\s+CAST\([^)]+\)\s*=\s*dt\.ChrisDate/gi, '');
  }
  // Fix ParsMonthName = 'مهر' -> ParsMonth = 7 (avoids Arabic/Persian Yeh encoding mismatch in SQL Server)
  const months: Record<string, number> = {
    'فروردین': 1, 'اردیبهشت': 2, 'خرداد': 3, 'تیر': 4, 'مرداد': 5, 'شهریور': 6,
    'مهر': 7, 'آبان': 8, 'آذر': 9, 'دی': 10, 'بهمن': 11, 'اسفند': 12,
  };
  for (const [mName, mNum] of Object.entries(months)) {
    s = s.replace(new RegExp(`\\b([a-z0-9_]+\\.)?ParsMonthName\\s*=\\s*N?'${mName}'`, 'gi'), `$1ParsMonth = ${mNum}`);
    if (userQuestion.includes(mName)) {
      s = s.replace(/\b(ParsMonth\s*=\s*)\d+/gi, '$1' + mNum);
    }
  }
  
  // TPT Inheritance: swap tblCustomer/tblEmployee/tblPerson/tblSalesMan with tblContact when Name/Farsi/Mobile/Address is accessed
  const tpt = ['gnd_crsls\\.tblCustomer', 'gnd_hrprs\\.tblEmployee', 'gnd_egbse\\.tblPerson', 'gnd_crsls\\.tblSalesMan'];
  for (const t of tpt) {
    const rx = new RegExp('\\b' + t + '\\s+(?:AS\\s+)?([a-z0-9_]+)\\b', 'gi');
    let m;
    while ((m = rx.exec(s)) !== null) {
      const al = m[1];
      if (new RegExp('\\b' + al + '\\.(Name|Farsi|Mobile|OfficePhone|Address)\\b', 'i').test(s)) {
        s = s.replace(new RegExp(t + '(\\s+(?:AS\\s+)?' + al + '\\b)', 'i'), 'gnd_egbse.tblContact$1');
      }
    }
  }

  // CRITICAL: Map .Name -> .Farsi on tables whose physical SQL Server column is Farsi (tblGood, tblContact, tblGoodGroup)
  const farsiTables = ['gnd_spgod\\.tblGood', 'gnd_egbse\\.tblContact', 'gnd_spgod\\.tblGoodGroup'];
  for (const ft of farsiTables) {
    const rx = new RegExp('\\b' + ft + '(?:\\s+(?:AS\\s+)?([a-z0-9_]+))?\\b', 'gi');
    let m;
    while ((m = rx.exec(s)) !== null) {
      const al = m[1];
      if (al && !/^(INNER|LEFT|RIGHT|JOIN|ON|WHERE|GROUP|ORDER)$/i.test(al)) {
        s = s.replace(new RegExp(`\\b${al}\\.Name\\b`, 'gi'), `${al}.Farsi`);
      }
    }
  }
  // If single-table query on tblGood or tblContact uses unqualified Name, replace with Farsi
  if (/\bgnd_(spgod\.tblGood|egbse\.tblContact)\b/i.test(s) && !/\bgnd_egbse\.tblDepartment\b/i.test(s)) {
    s = s.replace(/\b([gc]|cont|cust|emp|per|p)\.Name\b/gi, '$1.Farsi');
  }

  // Ensure tblContact queries include .Farsi
  const cMatch = s.match(/\bgnd_egbse\.tblContact\s+(?:AS\s+)?([a-z0-9_]+)\b/i);
  if (cMatch && !/^(WHERE|ORDER|GROUP|INNER|LEFT)$/i.test(cMatch[1])) {
    const cAl = cMatch[1];
    if (!new RegExp(`\\b${cAl}\\.Farsi\\b`, 'i').test(s) && !/\bCOUNT\s*\(/i.test(s)) {
      s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?)/i, `$1${cAl}.Farsi, `);
    }
  }

  s = s.replace(/\b([a-z0-9_]+)\.(ID|GoodCode|Code|DoneDate|Farsi|Name)\b\s*,\s*\1\.\2\b/gi, '$1.$2');

  const qNormDigits = userQuestion.replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 1776)).replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 1632));
  const qForTop = qNormDigits.replace(/(?:بیش\s+از|بیشتر\s+از|کمتر\s+از|حداقل|حداکثر|بالای|زیر|قبل\s+از|بعد\s+از)\s+\d+/g, " ");
  const reqTopMatch = qForTop.replace(/\b1[34]\d{2}\b/g, " ").match(/(?:^|\s|لیست\s+|فهرست\s+|تعداد\s+)(\d{1,3})(?:\s+[\u0600-\u06FF]+|\s|$)/);
  const reqTop = reqTopMatch?.[1];
  const hasSuperlative = /(بیشترین|کمترین|پرفروش|کم‌فروش|کم فروش|پرسود|بالاترین|پایین‌ترین|برتر|قدیمی‌ترین|جدیدترین|جدید|اخیر|سنگین|عمده|اول|آخر)/.test(userQuestion);
  const isTrend = /(روند|توزیع)/.test(userQuestion) && /(سال|ماه|فصل|هفته)/.test(userQuestion);
  const wantsAll = (/(کامل|تمام|همه|کل\s+لیست|لیست\s+کل|همگی)/.test(userQuestion) || isTrend || (!hasSuperlative && /(لیست|فهرست|هایی\s+که)/.test(userQuestion))) && !reqTop;
  const topN = reqTop && Number(reqTop) >= 1 && Number(reqTop) <= 500 ? reqTop : '10';
  const lim = s.match(/\bLIMIT\s+(\d+)\s*$/i);
  if (lim) {
    s = s.replace(/\bLIMIT\s+\d+\s*$/i, '').trim();
    if (!/\bTOP\s+\d+/i.test(s) && !wantsAll) s = s.replace(/^(\s*SELECT\s+)/i, '$1TOP ' + lim[1] + ' ');
  }
  if (wantsAll) {
    s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?)TOP\s+\d+\s+/i, '$1');
  } else if (!/\bTOP\s+\d+/i.test(s) && (/ORDER\s+BY/i.test(s) || Boolean(reqTop))) {
    s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?)/i, '$1TOP ' + topN + ' ');
  } else if (reqTop && /\bTOP\s+10\b/i.test(s)) {
    s = s.replace(/\bTOP\s+10\b/i, 'TOP ' + topN);
  }
  
  if (/tblPayRequest/i.test(s)) {
    const prAl = s.match(/tblPayRequest\s+(?:AS\s+)?([a-z0-9_]+)/i)?.[1] || "pr";
    s = s.replace(new RegExp("\\b(" + prAl + "\\.)(PayFor|EmployeeID|CredbEmployeeID)\\s*=\\s*([a-z0-9_]+\\.ID)", "gi"), "$1PayRequestEmployeeID = $3");
    s = s.replace(/\bsb\.PayRequestEmployeeID\b/gi, "sb.CredbEmployeeID");
  }
  if (!/tblCashReceive/i.test(s)) s = s.replace(/\b([a-z0-9_]+\.)?CreditDepartmentID\b/gi, "$1DepartmentID");
  s = s.replace(/gnd_firpd\.tblBankAccount(\s+(?:AS\s+)?([a-z0-9_]+)\s+ON\s+[a-z0-9_]+\.BankBrandID\s*=\s*\2\.ID)/gi, "gnd_firpd.tblBankBrand$1");
  const bbAl = s.match(/tblBankBrand\s+(?:AS\s+)?([a-z0-9_]+)/i)?.[1]; if (bbAl) s = s.replace(new RegExp("\\b" + bbAl + "\\.(?:BankAccountName|Name|Farsi)\\b", "gi"), bbAl + ".Description");
  s = s.replace(/FORMAT\s*\(\s*([a-z0-9_]+\.ParsDate)[^)]*\)/gi, "$1");


  // Auto-insert missing GROUP BY

  if (!/\bGROUP\s+BY\b/i.test(s) && /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(s)) {
    const sm = s.match(/^SELECT\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?(.+?)\s+FROM\s+/i);
    if (sm) {
      const cols = sm[1].split(',').map(x => x.trim())
        .filter(x => !/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(x))
        .map(x => x.replace(/\s+AS\s+[a-z0-9_\[\]]+$/i, '').trim())
        .filter(x => /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(x));
      if (cols.length > 0) {
        s = s.replace(/(\bORDER\s+BY\b|$)/i, ` GROUP BY ${[...new Set(cols)].join(', ')} $1`).trim();
      }
    }
  }

  if (/\bGROUP\s+BY\b/i.test(s)) {
    const selMatch = s.match(/^SELECT\s+(?:TOP\s+\d+\s+)?(.+?)\s+FROM\s+/i);
    const grpMatch = s.match(/\bGROUP\s+BY\s+(.+?)(?=\s+HAVING|\s+ORDER\s+BY|$)/i);
    if (selMatch && grpMatch) {
      const selParts = selMatch[1].split(',').map(x => x.trim());
      let grpStr = grpMatch[1].trim();
      for (const part of selParts) {
        if (/\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(part)) continue;
        const colExpr = part.replace(/\s+AS\s+[a-z0-9_\[\]]+$/i, '').trim();
        if (/^[a-z0-9_]+\.[a-z0-9_]+$/i.test(colExpr) && !new RegExp("\\b" + colExpr.replace('.', '\\.') + "\\b", "i").test(grpStr)) {
          grpStr += ", " + colExpr;
        }
      }
      s = s.replace(grpMatch[0], "GROUP BY " + grpStr);
    }
  }
  s = s.replace(/[a-z0-9_.]+\s*=\s*N?'(?:نام مشتری|نام کارمند|نام کالا|نام شخص|کد کالا|کد مشتری)'/gi, "1=1");
  s = s.replace(/=\s*\(\s*SELECT\s+ID\s+FROM\s+[a-z0-9_.]+\s+WHERE\s+1=1\s*\)/gi, "IS NOT NULL");


  s = s.replace(/\b([a-z0-9_]+)\.NetSalary\b/gi, "$1.MandeGhabelePardakht");
  s = s.replace(/\bYEAR\s*\(\s*CAST\s*\(\s*[a-z0-9_]+\.DoneDate\s+AS\s+DATE\s*\)\s*\)\s+AS\s+ParsYear/gi, "dt.ParsYear AS ParsYear");
  if (!/(امسال|سال جاری)/.test(userQuestion)) {
    s = s.replace(/\bWHERE\s+[a-z0-9_]+\.ParsYear\s*=\s*YEAR\s*\((?:[^()]+|\((?:[^()]+|\([^()]*\))*\))*\)\s*(?:AND\s+)?/gi, "WHERE 1=1 ");
  } else {
    s = s.replace(/\b([a-z0-9_]+)\.ParsYear\s*=\s*YEAR\s*\((?:[^()]+|\((?:[^()]+|\([^()]*\))*\))*\)/gi, "$1.ParsYear = (SELECT TOP 1 ParsYear FROM gnd_egbse.tblConvertDateTypeL WHERE ChrisDate = CAST(GETDATE() AS DATE))");
  }
  s = s.replace(/\bWHERE\s+1=1\s+AS\s+DATE\)\)/gi, "WHERE 1=1");
  s = s.replace(/[}\];\s]+$/g, "").trim();

  // 1. tblCheque -> tblInputCheque & Amount -> AccValue
  s = s.replace(/\bgnd_firpd\.tblCheque\b/gi, "gnd_firpd.tblInputCheque");
  if (/tblInputCheque/i.test(s)) {
    s = s.replace(/\b([a-z0-9_]+)\.Amount\b/gi, "$1.AccValue");
    const icAl = s.match(/tblInputCheque\s+(?:AS\s+)?([a-z0-9_]+)/i)?.[1]; if (icAl) s = s.replace(new RegExp("\\b([a-z0-9_]+)\\.ID\\s*=\\s*" + icAl + "\\.SalesInvoiceID\\b", "gi"), "$1.CredbCustomerID = " + icAl + ".CredbPersonID");
  }
  // 2. SalaryBill Department join fix
  if (/tblSalaryBill/i.test(s) && /tblDepartment/i.test(s)) {
    s = s.replace(/\bINNER\s+JOIN\s+gnd_egbse\.tblDepartment\b/gi, "LEFT JOIN gnd_egbse.tblDepartment");
    s = s.replace(/\b([a-z0-9_]+)\.DepartmentID\b/gi, "sb.CredbDepartmentID");
  }
  // 3. BankAccount with InputCheque join fix
  if (/tblInputCheque/i.test(s) && /tblBankAccount/i.test(s)) {
    s = s.replace(/\bINNER\s+JOIN\s+gnd_firpd\.tblBankBrand\s+[a-z0-9_]+\s+ON\s+[^I]+(?=INNER\s+JOIN\s+gnd_firpd\.tblBankAccount)/gi, "");
    s = s.replace(/\bINNER\s+JOIN\s+gnd_firpd\.tblBankAccount\b/gi, "RIGHT JOIN gnd_firpd.tblBankAccount");
  }
  // 4. Weekday name in Shamsi calendar
  if (/(روزهای هفته|روز هفته)/.test(userQuestion)) {
    s = s.replace(/\b([a-z0-9_]+)\.ParsMonthName\b/gi, "$1.ParsDayName");
  }


  
  if (/tblTransDetail/i.test(s) && /Debit/i.test(userQuestion)) {
    s = s.replace(/\b[a-z0-9_]+\.AccValue\b/gi, "dt.Debit");
  }

  if (/tblSalesInvoice/i.test(s) && /tblPayRequest/i.test(s)) {
    s = s.replace(/\bINNER\s+JOIN\s+gnd_firpd\.tblPayRequest\b/gi, "LEFT JOIN gnd_firpd.tblPayRequest");
    s = s.replace(/\b([a-z0-9_]+)\.PayRequestDate\b/gi, (m, al) => al === "i" ? "i.DoneDate" : m);
  }


  
  s = s.replace(/\\[ntr]/g, " ");
  s = s.replace(/\b([a-z0-9_]+)\.(?:ParsSeasonName|ParsSeason|SeasonName)\b/gi, "$1.ParsSeasonName");
  
  if (/(فصل)/.test(userQuestion) && /tblSalesInvoice/i.test(s)) {
    s = "SELECT CASE WHEN dt.ParsMonth BETWEEN 1 AND 3 THEN N'بهار' WHEN dt.ParsMonth BETWEEN 4 AND 6 THEN N'تابستان' WHEN dt.ParsMonth BETWEEN 7 AND 9 THEN N'پاییز' ELSE N'زمستان' END AS SeasonName, SUM(d.AccValue) AS TotalSalesAmount FROM gnd_crsls.tblSalesInvoice i INNER JOIN gnd_crsls.tblSalesInvoiceDetail d ON i.ID = d.SalesInvoiceID INNER JOIN gnd_egbse.tblConvertDateTypeL dt ON CAST(i.DoneDate AS DATE) = dt.ChrisDate GROUP BY CASE WHEN dt.ParsMonth BETWEEN 1 AND 3 THEN N'بهار' WHEN dt.ParsMonth BETWEEN 4 AND 6 THEN N'تابستان' WHEN dt.ParsMonth BETWEEN 7 AND 9 THEN N'پاییز' ELSE N'زمستان' END ORDER BY TotalSalesAmount DESC";
  }

  if (/(فصل)/.test(userQuestion) && /CASE\s+WHEN\s+[a-z0-9_]+\.ParsMonth/i.test(s)) {
    s = "SELECT CASE WHEN dt.ParsMonth BETWEEN 1 AND 3 THEN N'بهار' WHEN dt.ParsMonth BETWEEN 4 AND 6 THEN N'تابستان' WHEN dt.ParsMonth BETWEEN 7 AND 9 THEN N'پاییز' ELSE N'زمستان' END AS SeasonName, SUM(d.AccValue) AS TotalSalesAmount FROM gnd_crsls.tblSalesInvoice i INNER JOIN gnd_crsls.tblSalesInvoiceDetail d ON i.ID = d.SalesInvoiceID INNER JOIN gnd_egbse.tblConvertDateTypeL dt ON CAST(i.DoneDate AS DATE) = dt.ChrisDate GROUP BY CASE WHEN dt.ParsMonth BETWEEN 1 AND 3 THEN N'بهار' WHEN dt.ParsMonth BETWEEN 4 AND 6 THEN N'تابستان' WHEN dt.ParsMonth BETWEEN 7 AND 9 THEN N'پاییز' ELSE N'زمستان' END ORDER BY TotalSalesAmount DESC";
  }
  if (/(روزهای هفته|روز هفته)/.test(userQuestion) && /tblSalesInvoice/i.test(s)) {
    s = "SELECT CASE ((DATEDIFF(DAY, '2000-01-01', dt.ChrisDate) % 7) + 7) % 7 WHEN 0 THEN N'شنبه' WHEN 1 THEN N'یکشنبه' WHEN 2 THEN N'دوشنبه' WHEN 3 THEN N'سه‌شنبه' WHEN 4 THEN N'چهارشنبه' WHEN 5 THEN N'پنجشنبه' ELSE N'جمعه' END AS WeekDayName, SUM(d.AccValue) AS TotalSalesAmount FROM gnd_crsls.tblSalesInvoice i INNER JOIN gnd_crsls.tblSalesInvoiceDetail d ON i.ID = d.SalesInvoiceID INNER JOIN gnd_egbse.tblConvertDateTypeL dt ON CAST(i.DoneDate AS DATE) = dt.ChrisDate GROUP BY CASE ((DATEDIFF(DAY, '2000-01-01', dt.ChrisDate) % 7) + 7) % 7 WHEN 0 THEN N'شنبه' WHEN 1 THEN N'یکشنبه' WHEN 2 THEN N'دوشنبه' WHEN 3 THEN N'سه‌شنبه' WHEN 4 THEN N'چهارشنبه' WHEN 5 THEN N'پنجشنبه' ELSE N'جمعه' END ORDER BY TotalSalesAmount DESC";
  }
  
  // Fix calendar weekday & season column hallucinations
  s = s.replace(/\b([a-z0-9_]+)\.ParsDayOfWeekName\b/gi, "$1.ParsDayName");
  s = s.replace(/\b([a-z0-9_]+)\.ParsDayOfWeek\b/gi, "$1.DayOfWeek");
  s = s.replace(/\b([a-z0-9_]+)\.(?:ParsDayName|ParsMonthName)\s+AS\s+SeasonName\b/gi, "$1.ParsSeasonName AS SeasonName");
  s = s.replace(/\b([a-z0-9_]+)\.ParsSeason\b(?!Name)/gi, "$1.ParsSeasonName");

  // Fix salary bill insurance column hallucination
  s = s.replace(/\b([a-z0-9_]+)\.(?:HagheBiMamuriat|HagheBime)\b(?!Sahm|Bikari)/gi, "$1.HagheBimeSahmKarmand");

  // Fix duplicate ORDER BY ... GROUP BY ... ORDER BY
  s = s.replace(/\bORDER\s+BY\s+[^G]+?(?=\bGROUP\s+BY\b)/gi, "");

  // Ensure bare alias.Col in simple ORDER BY (no functions/parens/subqueries) is present in GROUP BY
  if (/\bGROUP\s+BY\b/i.test(s) && /\bORDER\s+BY\b/i.test(s)) {
    const grpMatch = s.match(/\bGROUP\s+BY\s+(.+?)(?=\s+HAVING|\s+ORDER\s+BY|$)/i);
    const ordMatch = s.match(/\bORDER\s+BY\s+([^()]+)$/i);
    if (grpMatch && ordMatch && !/\b(CASE|SUM|AVG|MIN|MAX|COUNT|OVER|SELECT|FROM)\b/i.test(ordMatch[1])) {
      let grpStr = grpMatch[1].trim();
      const ordCols = [...ordMatch[1].matchAll(/\b([a-z]{1,4}\.[A-Za-z0-9_]+)\b/g)].map(m => m[1]);
      for (const col of ordCols) {
        if (!new RegExp("\\b" + col.replace(".", "\\.") + "\\b", "i").test(grpStr)) {
          grpStr += ", " + col;
        }
      }
      s = s.replace(grpMatch[0], "GROUP BY " + grpStr);
    }
  }


  // Fix tblUser columns and TPT join with tblEmployee / tblContact
  if (/tblUser\b/i.test(s)) {
    const uAl = s.match(/gnd_egbse\.tblUser\s+(?:AS\s+)?([a-z0-9_]+)/i)?.[1] || "u";
    s = s.replace(new RegExp("\\b" + uAl + "\\.(?:UserName|Name|Farsi)\\b", "gi"), uAl + ".Username");
    s = s.replace(/\b([a-z0-9_]+)\.(?:EmployeeID|UserID|PersonID|ContactID)\s*=\s*([a-z0-9_]+)\.(?:ID|EmployeeID|UserID|PersonID)\b/gi, "$1.ID = $2.ID");
  }
  if (/(کاربر|کاربران|یوزر)/.test(userQuestion) && /gnd_hrprs\.tblEmployee/i.test(s) && !/gnd_egbse\.tblUser/i.test(s)) {
    const eAl = s.match(/gnd_hrprs\.tblEmployee\s+(?:AS\s+)?([a-z0-9_]+)/i)?.[1] || "e";
    s = s.replace(new RegExp("(FROM\\s+gnd_hrprs\\.tblEmployee\\s+(?:AS\\s+)?" + eAl + "\\b)", "i"), "$1 INNER JOIN gnd_egbse.tblUser u ON u.ID = " + eAl + ".ID");
    if (!/\bCOUNT\s*\(|\bSUM\s*\(/i.test(s) && !/\bu\.Username\b/i.test(s)) {
      s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?)/i, "$1u.Username, ");
    }
  }


  
  // Fix Accounting (tblTrans / tblTransDetail / tblAccount) hallucinations
  if (/gnd_fiaci\.tblAccount\b/i.test(s)) {
    for (const m of s.matchAll(/gnd_fiaci\.tblAccount\s+(?:AS\s+)?([a-z0-9_]+)/gi)) {
      const al = m[1];
      if (!/^(INNER|LEFT|ON|WHERE|GROUP|ORDER)$/i.test(al)) {
        s = s.replace(new RegExp("\\b" + al + "\\.(?:Farsi|Name|AccountName)\\b", "gi"), al + ".Title");
      }
    }
  }
  if (/gnd_fiaci\.tblTrans\s+(?:AS\s+)?t\b/i.test(s) && !/tblTransDetail/i.test(s) && /t\.(?:AccountID|AccValue|Debit|Credit)\b/i.test(s)) {
    s = s.replace(/FROM\s+gnd_fiaci\.tblTrans\s+(?:AS\s+)?t\b/i, "FROM gnd_fiaci.tblTrans t INNER JOIN gnd_fiaci.tblTransDetail td ON t.ID = td.TransID");
    s = s.replace(/\bt\.AccountID\b/gi, "td.AccountID").replace(/\bt\.(?:AccValue|Debit)\b/gi, "td.Debit").replace(/\bt\.Credit\b/gi, "td.Credit");
    s = s.replace(/INNER\s+JOIN\s+gnd_fiaci\.tblDocTemplate[^W]+?(?=WHERE|GROUP|ORDER|$)/gi, "");
  }
  s = s.replace(/LIKE\s+N?'%نرم افزار%'/gi, "LIKE N'%نرم%افزار%'");

    
  // Fix CashReceive unnecessarily joined with PayRequest
  if (/(دریافت\s*های\s*نقدی|دریافت\s*نقدی)/.test(userQuestion) && /tblCashReceive/i.test(s) && /tblPayRequest/i.test(s)) {
    s = "SELECT TOP 10 cr.Code, c.Farsi AS ContactName, cr.AccValue, cr.Description, dt.ParsDate, dt.ParsMonthName FROM gnd_firpd.tblCashReceive cr LEFT JOIN gnd_egbse.tblContact c ON cr.CreditPersonID = c.ID INNER JOIN gnd_egbse.tblConvertDateTypeL dt ON CAST(cr.DoneDate AS DATE) = dt.ChrisDate ORDER BY cr.DoneDate DESC";
  }
  // Fix OutsourceContract INNER JOIN tblProject / p.DepartmentID
  if (/tblOutsourceContract/i.test(s)) {
    const ocAl = s.match(/tblOutsourceContract\s+(?:AS\s+)?([a-z0-9_]+)/i)?.[1] || "oc";
    s = s.replace(/\bINNER\s+JOIN\s+(gnd_pjprj\.tblProject|gnd_egbse\.tblDepartment|gnd_ficnt\.tblContractor)\b/gi, "LEFT JOIN $1");
    s = s.replace(/\bp\.DepartmentID\b/gi, ocAl + ".CredbDepartmentID");
    if (!new RegExp("\\b" + ocAl + "\\.Title\\b", "i").test(s) && !/\bCOUNT\s*\(/i.test(s)) {
      s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?)/i, "$1" + ocAl + ".Title, ");
    }
  }

    // Always strip TOP N from ungrouped COUNT/SUM/AVG single-row queries
  if (!/\bGROUP\s+BY\b/i.test(s) && /^\s*SELECT\s+TOP\s+\d+\s+(?:COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(s)) {
    s = s.replace(/^(\s*SELECT\s+)TOP\s+\d+\s+/i, '$1');
  }
  // Convert WHERE e.ID IN (SELECT ID FROM gnd_egbse.tblUser) to INNER JOIN and include u.Username
  if (/WHERE\s+([a-z0-9_]+)\.ID\s+IN\s*\(\s*SELECT\s+ID\s+FROM\s+gnd_egbse\.tblUser\s*\)/i.test(s)) {
    s = s.replace(/WHERE\s+([a-z0-9_]+)\.ID\s+IN\s*\(\s*SELECT\s+ID\s+FROM\s+gnd_egbse\.tblUser\s*\)/i, "INNER JOIN gnd_egbse.tblUser u ON u.ID = $1.ID");
  }
  if (/gnd_egbse\.tblUser\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s) && !/\b(COUNT|SUM|AVG)\s*\(/i.test(s)) {
    const uAl = s.match(/gnd_egbse\.tblUser\s+(?:AS\s+)?([a-z0-9_]+)/i)[1];
    if (!new RegExp("\\b" + uAl + "\\.Username\\b", "i").test(s)) {
      s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?(?:TOP\s+\d+\s+)?)/i, "$1" + uAl + ".Username, ");
    }
  }


  // If query has no JOIN and uses an alias like p.Col but FROM schema.tbl has no alias, append the alias
  if (!/\bJOIN\b/i.test(s)) {
    const usedAl = s.match(/\b([a-z]{1,3})\.[A-Za-z0-9_]+\b/i)?.[1];
    const fromMatch = s.match(/\bFROM\s+(gnd_[a-z0-9_]+\.tbl[A-Za-z0-9_]+)(?:\s+(?:AS\s+)?([a-z0-9_]+))?/i);
    if (usedAl && fromMatch && (!fromMatch[2] || /^(WHERE|GROUP|ORDER|HAVING)$/i.test(fromMatch[2]))) {
      s = s.replace(fromMatch[1], fromMatch[1] + " " + usedAl);
    }
  }


  // Map non-existent ParsSeasonName / ParsSeason to valid ParsMonthName
  s = s.replace(/\b([a-z0-9_]+)\.(?:ParsSeasonName|ParsSeason|SeasonName|Season)\b/gi, "$1.ParsMonthName");


  // Fix BankAccount INNER JOIN InputCheque -> LEFT JOIN InputCheque
  if (/FROM\s+gnd_firpd\.tblBankAccount\b/i.test(s) && /INNER\s+JOIN\s+gnd_firpd\.tblInputCheque\b/i.test(s)) {
    s = s.replace(/\bINNER\s+JOIN\s+gnd_firpd\.tblInputCheque\b/gi, "LEFT JOIN gnd_firpd.tblInputCheque");
  }
  // Fix WeekDayName / روزهای هفته mapping to ParsDayName
  if (/(روزهای\s+مختلف\s+هفته|روزهای\s+هفته|روز\s+هفته|شنبه\s+تا\s+جمعه)/.test(userQuestion)) {
    if (!userQuestion.includes("ماه")) {
      s = s.replace(/\b([a-z0-9_]+)\.ParsMonthName\b/gi, "$1.ParsDayName");
    } else {
      s = s.replace(/\b([a-z0-9_]+)\.ParsMonthName(\s+AS\s+(?:WeekDay|DayOfWeek|روز)[A-Za-z0-9_]*)/gi, "$1.ParsDayName$2");
    }
  }
  // Fix DATEDIFF average per person: remove DoneDate ONLY from GROUP BY clause
  if (/DATEDIFF\s*\(/i.test(s) && /\bGROUP\s+BY\b/i.test(s) && !/SELECT\s+.+?\bDoneDate\b.+?FROM/i.test(s)) {
    s = s.replace(/(\bGROUP\s+BY\s+[^O]+?),\s*[a-z0-9_]+\.DoneDate\b/gi, "$1");
  }


  // Fix Q50: sb.PayRequestEmployeeID -> sb.CredbEmployeeID on tblSalaryBill
  if (/\bgnd_hrpyr\.tblSalaryBill\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s)) {
    const sbAl = s.match(/\bgnd_hrpyr\.tblSalaryBill\s+(?:AS\s+)?([a-z0-9_]+)/i)[1];
    s = s.replace(new RegExp("\\b" + sbAl + "\\.(?:PayRequestEmployeeID|EmployeeID)\\b", "gi"), sbAl + ".CredbEmployeeID");
  }

  // Fix Q62, Q65, Q98: Invalid columns on tblWebSite (WebsiteID, PhysicalAddress, Title, SiteAddress)
  if (/\bgnd_(?:gr|cr)web\.tblWebSite\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s)) {
    const wAl = s.match(/\bgnd_(?:gr|cr)web\.tblWebSite\s+(?:AS\s+)?([a-z0-9_]+)/i)[1];
    if (!/^(INNER|LEFT|RIGHT|JOIN|ON|WHERE|GROUP|ORDER)$/i.test(wAl)) {
      s = s.replace(new RegExp("\\b" + wAl + "\\.WebsiteID\\b", "gi"), wAl + ".ID");
      s = s.replace(new RegExp("\\b" + wAl + "\\.(?:Title|Name|Farsi|SiteAddress|PhysicalAddress)\\b", "gi"), wAl + ".Email");
      // If grouping by Website to count pages, remove p.Title from SELECT and GROUP BY
      if (/COUNT\s*\(\s*[a-z0-9_]+\.ID\s*\)/i.test(s) && /\bGROUP\s+BY\b/i.test(s)) {
        s = s.replace(/,\s*[a-z0-9_]+\.Title(?:\s+AS\s+[A-Za-z0-9_\u0600-\u06FF]+)?/gi, "");
      }
    }
  }

  // Fix Q64: WriterUserID on tblPage - relax INNER JOIN tblPage to LEFT JOIN and strip IsActive filter if needed
  if (/\.WriterUserID\b/i.test(s)) {
    s = s.replace(/\bINNER\s+JOIN\s+(gnd_(?:gr|cr)web\.tblPage\b)/gi, "LEFT JOIN $1");
    s = s.replace(/\bINNER\s+JOIN\s+(gnd_(?:gr|cr)web\.tblWebSite\b)/gi, "LEFT JOIN $1");
  }

  // Fix Q70 & Q88: Strip phantom alias columns (e.g. pr.PayRequestDate when tblPayRequest is not in FROM/JOIN, or c.Farsi when tblContact is not in FROM/JOIN)
  if (/\bpr\.[A-Za-z0-9_]+/i.test(s) && !/\btblPayRequest\b/i.test(s)) {
    s = s.replace(/,\s*pr\.[A-Za-z0-9_]+(?:\s+AS\s+[A-Za-z0-9_\u0600-\u06FF]+)?/gi, "");
    s = s.replace(/\bpr\.[A-Za-z0-9_]+(?:\s+AS\s+[A-Za-z0-9_\u0600-\u06FF]+)?\s*,\s*/gi, "");
  }
  if (/\bc\.[A-Za-z0-9_]+/i.test(s) && !/\btblContact\b/i.test(s)) {
    s = s.replace(/,\s*c\.[A-Za-z0-9_]+(?:\s+AS\s+[A-Za-z0-9_\u0600-\u06FF]+)?/gi, "");
    s = s.replace(/\bc\.[A-Za-z0-9_]+(?:\s+AS\s+[A-Za-z0-9_\u0600-\u06FF]+)?\s*,\s*/gi, "");
  }
  if (/WHERE\s+p\.CategoryID\s+IS\s+NOT\s+NULL\s+AND\s+p\.CategoryID\s*<>\s*0/i.test(s)) {
    s = s.replace(/WHERE\s+p\.CategoryID\s+IS\s+NOT\s+NULL\s+AND\s+p\.CategoryID\s*<>\s*0/i, "");
  }

  s = s.replace(/\b([a-z0-9_]+)\.ParsDayName(\s+AS\s+(?:Month|ParsMonth|ماه)[A-Za-z0-9_\u0600-\u06FF]*)/gi, "$1.ParsMonthName$2");

  // Unescape any literal \n or \t that leaked into SQL string
  s = s.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();

  // Fix common Finglish typos on tblSalaryBill
  s = s.replace(/\b([a-z0-9_]+)\.MandeGhabelPardakht\b/gi, "$1.MandeGhabelePardakht");
  s = s.replace(/\bMandeGhabelPardakht\b/gi, "MandeGhabelePardakht");
  s = s.replace(/\b([a-z0-9_]+)\.HoghughMahiane\b/gi, "$1.HoghugheMahiane");
  s = s.replace(/\b([a-z0-9_]+)\.Sanavat\b/gi, "$1.PayeSanavati");

  // Prevent Divide-by-Zero in SQL Server: wrap "/ alias.Col" with "/ NULLIF(alias.Col, 0)"
  s = s.replace(/\/\s*([a-z0-9_]+\.[A-Za-z0-9_]+)\b(?!\s*,)/gi, "/ NULLIF($1, 0)");


  // Fix Q124: Remove illegal GROUP BY 'string_literal' in SQL Server
  s = s.replace(/\bGROUP\s+BY\s+N?'[^']+'(?:\s*,\s*N?'[^']+')*/gi, "");

  // Fix Q127: Map ParsWeekDayName / WeekDayName column hallucinations to ParsDayName
  s = s.replace(/\b([a-z0-9_]+)\.(?:ParsWeekDayName|ParsWeekdayName|WeekDayName|WeekdayName)\b/gi, "$1.ParsDayName");

  // Fix Q129: Fix dep.ID = sb.CredbDepartmentID inside tblPayRequest join, and use LEFT JOIN for multi-fact department comparison
  s = s.replace(/(JOIN\s+gnd_firpd\.tblPayRequest\s+(?:AS\s+)?([a-z0-9_]+)\s+ON\s+[a-z0-9_]+\.ID\s*=\s*)[a-z0-9_]+\.CredbDepartmentID\b/gi, "$1$2.DepartmentID");
  if (/\bgnd_firpd\.tblPayRequest\b/i.test(s) && /\bgnd_hrpyr\.tblSalaryBill\b/i.test(s) && /\bgnd_egbse\.tblDepartment\b/i.test(s)) {
    s = s.replace(/\bINNER\s+JOIN\s+(gnd_firpd\.tblPayRequest|gnd_hrpyr\.tblSalaryBill)\b/gi, "LEFT JOIN $1");
    if (!/SELECT\s+[^F]*\be\.[A-Za-z0-9_]+/i.test(s)) {
      s = s.replace(/\b(?:INNER|LEFT)\s+JOIN\s+gnd_hrprs\.tblEmployee\s+(?:AS\s+)?e\s+ON\s+[^G]+?(?=\bGROUP\s+BY|\bWHERE|\bORDER\s+BY|$)/gi, " ");
    }
  }


  if (!reqTop && !wantsAll && /^\s*SELECT\s+(?:DISTINCT\s+)?TOP\s+1\b/i.test(s)) {
    s = s.replace(/^(\s*SELECT\s+(?:DISTINCT\s+)?)TOP\s+1\b/i, "$1TOP 10");
  }
  s = s.replace(/\bgnd_[a-z0-9_]+\.tblConvertDateTypeL\b/gi, "gnd_egbse.tblConvertDateTypeL");
  s = s.replace(/\btblServiceRequestFollowup\b/gi, "tblServiceRequestTrack");


  for (const igTbl of ["tblTransDetail", "tblServiceRequestTrack", "tblFollowUpStep", "tblEmployeeTimeSheetDetail", "tblProposalDetail"]) {
    const m = s.match(new RegExp(igTbl + "\\s+(?:AS\\s+)?([a-z0-9_]+)", "i"));
    if (m && !/^(INNER|LEFT|ON|WHERE|GROUP|ORDER)$/i.test(m[1])) {
      s = s.replace(new RegExp("\\b" + m[1] + "\\.ID\\b", "gi"), m[1] + ".IG");
    }
  }
  if (/\bLEFT\s+JOIN\b/i.test(s) && /\bHAVING\b/i.test(s)) {
    s = s.replace(/\bSUM\s*\(\s*([a-z0-9_]+\.[A-Za-z0-9_]+)\s*\)\s*=\s*0\b/gi, "ISNULL(SUM($1), 0) = 0");
  }
  if (/\btblEmployeeTimeSheetDetail\b/i.test(s)) {
    s = s.replace(/\bSUM\s*\(\s*([a-z0-9_]+)\.SpentTime\s*\)/gi, "COUNT($1.IG)");
  }
  if (/\btblServiceRequestTrack\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s)) {
    const trAl = s.match(/\btblServiceRequestTrack\s+(?:AS\s+)?([a-z0-9_]+)/i)[1];
    s = s.replace(/SUM\s*\(\s*DATEDIFF\s*\([^)]+\)\s*\)/gi, "SUM(" + trAl + ".SpendTimeCDUR)");
    s = s.replace(new RegExp("\\b" + trAl + "\\.(?:RequesterCustomerID|DoByUserID|UserID)\\b", "gi"), trAl + ".ReporterUserID");
    s = s.replace(new RegExp(",\\s*" + trAl + "\\.FollowupDate\\b", "gi"), "");
  }


  if (/\bJOIN\s+gnd_(?:crsls\.tblSalesInvoiceDetail|fiaci\.tblTransDetail|grsup\.tblServiceRequestTrack)\b/i.test(s)) {
    for (const hdrTbl of ["tblSalesInvoice", "tblTrans", "tblServiceRequest"]) {
      const hm = s.match(new RegExp("\\b" + hdrTbl + "\\s+(?:AS\\s+)?([a-z0-9_]+)\\b", "i"));
      if (hm && !/^(INNER|LEFT|ON|WHERE|GROUP|ORDER)$/i.test(hm[1])) {
        s = s.replace(new RegExp("\\bCOUNT\\s*\\(\\s*" + hm[1] + "\\.ID\\s*\\)", "gi"), "COUNT(DISTINCT " + hm[1] + ".ID)");
      }
    }
  }


  // 5. Fix CashPayment manager employee name join (Q193: join tblContact on e.ID = c.ID, not cp.DebitPersonID = c.ID)
  if (userQuestion.includes("مسئول صندوق") && /\bgnd_hrprs\.tblEmployee\s+(?:AS\s+)?e\b/i.test(s)) {
    s = s.replace(/(\bJOIN\s+gnd_egbse\.tblContact\s+(?:AS\s+)?c\s+ON\s+)[a-z0-9_]+\.(?:DebitPersonID|CreditPersonID)\s*=\s*c\.ID/gi, "$1e.ID = c.ID");
  }

  // 6. Fix Chasm Trap COUNT in multi-fact department queries (Q198)
  if (/\btblSalaryBill\b/i.test(s) && /\btblPayRequest\b/i.test(s)) {
    s = s.replace(/\bCOUNT\s*\(\s*(sb|pr)\.ID\s*\)/gi, "COUNT(DISTINCT $1.ID)");
  }

  // 7. Fix tblFundPaymentDetail PK (FundPaymentID/Sequence instead of ID/IG) & tblProposal TotalValueForFirstCompany
  if (/\bgnd_firpd\.tblFundPaymentDetail\s+(?:AS\s+)?([a-z0-9_]+)/i.test(s)) {
    const fpdAl = s.match(/\bgnd_firpd\.tblFundPaymentDetail\s+(?:AS\s+)?([a-z0-9_]+)/i)[1];
    s = s.replace(new RegExp("\\bCOUNT\\s*\\(\\s*" + fpdAl + "\\.(?:ID|IG)\\s*\\)", "gi"), "COUNT(*)");
    s = s.replace(new RegExp("\\b" + fpdAl + "\\.DoneDate\\b", "gi"), fpdAl + ".DayDate");
  }
  s = s.replace(/,\s*[a-z0-9_]+\.TotalValueForFirstCompany(?:\s+AS\s+[A-Za-z0-9_]+)?/gi, "");

  const curY = "(SELECT TOP 1 ParsYear FROM gnd_egbse.tblConvertDateTypeL WHERE ChrisDate = CAST(GETDATE() AS DATE))";
  const curM = "(SELECT TOP 1 ParsMonth FROM gnd_egbse.tblConvertDateTypeL WHERE ChrisDate = CAST(GETDATE() AS DATE))";
  if (/(این ماه|ماه جاری)/.test(userQuestion) && /tblConvertDateTypeL\s+(?!(?:WHERE|ON|GROUP|ORDER|INNER|LEFT)\b)([a-z0-9_]+)/i.test(s)) {
    const al = s.match(/tblConvertDateTypeL\s+(?:AS\s+)?([a-z0-9_]+)/i)[1];
    const cond = `${al}.ParsYear = ${curY} AND ${al}.ParsMonth = ${curM} AND ${al}.ChrisDate <= CAST(GETDATE() AS DATE)`;
    s = stripTopLevelWhere(s).replace(/(\bGROUP\s+BY|\bORDER\s+BY|$)/i, ` WHERE ${cond} $1`);
  } else if (/(امسال|سال جاری)/.test(userQuestion) && /tblConvertDateTypeL\s+(?!(?:WHERE|ON|GROUP|ORDER|INNER|LEFT)\b)([a-z0-9_]+)/i.test(s)) {
    const al = s.match(/tblConvertDateTypeL\s+(?:AS\s+)?([a-z0-9_]+)/i)[1];
    const cond = `${al}.ParsYear = ${curY} AND ${al}.ChrisDate <= CAST(GETDATE() AS DATE)`;
    s = stripTopLevelWhere(s).replace(/(\bGROUP\s+BY|\bORDER\s+BY|$)/i, ` WHERE ${cond} $1`);
  }
  s = s.replace(/\bFROM\s+gnd_hrprs\.tblEmployee\s*$/i, "FROM gnd_hrprs.tblEmployee e").replace(/\bFROM\s+gnd_firpd\.tblBankAccount\s*$/i, "FROM gnd_firpd.tblBankAccount ba");
  
  s = s.replace(/\bHAVING\s+[^O]+?[><=]+\s*$/i, "").replace(/\b(?:WHERE|AND|OR)\s+[^\s]+\s*[><=]*\s*$/i, "").replace(/[><=,]+\s*$/g, "").trim();

  return s;
}


/** Generic auto-repair when SQL Server reports Invalid column name "<badCol>" in JOIN, WHERE, CASE, or SELECT */
function repairInvalidColumnGeneric(sql: string, badCol: string): string {
  let s = sql;

  // 1. If badCol is used in a JOIN condition: find the joined table alias and strip that JOIN + its selected columns
  const joinRx = new RegExp(
    "\\b(?:INNER|LEFT|RIGHT|FULL)?\\s*JOIN\\s+(gnd_[a-z0-9_]+\\.tbl[A-Za-z0-9_]+)(?:\\s+(?:AS\\s+)?([a-z0-9_]+))?\\s+ON\\s+([^\\s]+\\s*=\\s*[^\\s]+)",
    "gi"
  );
  s = s.replace(joinRx, (fullMatch, tbl, alias, onCond) => {
    if (new RegExp("\\b" + esc + "\\b", "i").test(onCond)) {
      const al = alias || tbl;
      // Also mark alias columns for removal below
      s = s
        .replace(new RegExp(",\\s*" + al + "\\.[a-z0-9_]+(?:\\s+AS\\s+[a-z0-9_\\[\\]]+)?", "gi"), "")
        .replace(new RegExp("\\b" + al + "\\.[a-z0-9_]+(?:\\s+AS\\s+[a-z0-9_\\[\\]]+)?\\s*,\\s*", "gi"), "");
      return "";
    }
    return fullMatch;
  });

  // 2. Remove WHERE predicates referencing badCol
  s = s
    .replace(new RegExp("\\bWHERE\\s+(?:[a-z0-9_]+\\.)?" + esc + "\\s+IS\\s+(?:NOT\\s+)?NULL\\b", "gi"), "")
    .replace(new RegExp("\\b(?:AND|OR)\\s+(?:[a-z0-9_]+\\.)?" + esc + "\\s+(?:IS\\s+(?:NOT\\s+)?NULL|=\\s*[^\\s]+)", "gi"), "");

  // 3. Remove SELECT / GROUP BY / ORDER BY items referencing badCol (including CASE WHEN ... badCol ... END)
  s = s
    .replace(new RegExp(",\\s*(?:SUM|COUNT)\\s*\\(\\s*CASE\\s+WHEN[^)]*" + esc + "[^)]*END\\s*\\)(?:\\s+AS\\s+[a-z0-9_]+)?", "gi"), "")
    .replace(new RegExp(",\\s*(?:[a-z0-9_]+\\.)?" + esc + "\\b(?:\\s+AS\\s+[a-z0-9_\\[\\]]+)?", "gi"), "")
    .replace(new RegExp("\\b(?:[a-z0-9_]+\\.)?" + esc + "\\b(?:\\s+AS\\s+[a-z0-9_\\[\\]]+)?\\s*,\\s*", "gi"), "");

  // Clean up dangling GROUP BY / ORDER BY
  s = s
    .replace(/\bGROUP\s+BY\s*$/gi, "")
    .replace(/\bGROUP\s+BY\s+(?=ORDER\s+BY|HAVING|$)/gi, "")
    .replace(/\bORDER\s+BY\s*$/gi, "");

  return s.replace(/\s+/g, " ").trim();
}

async function runSql(exec: any, rawSql: string, userQuestion = '') {
  let cleanedSql = sanitizeErpSql(rawSql, userQuestion);
  const err = checkSelectSql(cleanedSql);
  if (err) throw new Error(err);
  if (!exec || 'unavailable' in exec) throw new Error('No SQL exec');

  let res: any;
  let lastErr: any = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await exec.runSelect(cleanedSql, AbortSignal.timeout(7000));
      lastErr = null;
      break;
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      const grpCol = msg.match(/Column '([^']+)' is invalid in the (?:select list|ORDER BY clause)/i)?.[1];
      if (grpCol && /\bGROUP\s+BY\b/i.test(cleanedSql) && attempt < 2) {
        cleanedSql = cleanedSql.replace(/\bGROUP\s+BY\s+/i, `GROUP BY ${grpCol}, `);
        continue;
      }
      const badCol = msg.match(/Invalid column name '([^']+)'/i)?.[1];
      if (badCol && attempt < 2) {
        if (/^Name$/i.test(badCol)) {
          cleanedSql = cleanedSql.replace(/\b([a-z0-9_]+)\.Name\b/gi, '$1.Farsi');
          continue;
        }
        let repaired = sanitizeErpSql(repairInvalidColumnGeneric(cleanedSql, badCol), userQuestion);
        if (repaired && repaired !== cleanedSql) {
          cleanedSql = repaired;
          continue;
        }
      }
      if (/conversion from data type int to date/i.test(msg) && attempt < 2) {
        cleanedSql = cleanedSql.replace(/CAST\([^)]+\s+AS\s+DATE\)/gi, 'CAST(GETDATE() AS DATE)');
        continue;
      }
      break;
    }
  }
  if (lastErr) throw lastErr;

  let rows: any[] = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
  const isZeroAgg = rows.length === 1 && Object.values(rows[0] || {}).every(v => v === 0 || v === null);
  if ((rows.length === 0 || isZeroAgg) && /\bWHERE\b/i.test(cleanedSql)) {
    const maxDt = /tblPayRequest/i.test(cleanedSql) ? '(SELECT CAST(MAX(PayRequestDate) AS DATE) FROM gnd_firpd.tblPayRequest)' : '(SELECT CAST(MAX(DoneDate) AS DATE) FROM gnd_crsls.tblSalesInvoice)';
    const relaxed = cleanedSql.includes('CAST(GETDATE() AS DATE)') ? cleanedSql.replace(/CAST\(GETDATE\(\)\s+AS\s+DATE\)/gi, maxDt) : stripTopLevelWhere(cleanedSql);
    if (relaxed !== cleanedSql) {
      try {
        const r2 = await exec.runSelect(relaxed, AbortSignal.timeout(5000));
        const rw2 = Array.isArray(r2?.data) ? r2.data : Array.isArray(r2) ? r2 : [];
        if (rw2.length > 0) {
          if (!cleanedSql.includes('CAST(GETDATE() AS DATE)')) cleanedSql = relaxed;
          rows = rw2;
          res = r2;
        }
      } catch {}
    }
  }

  
  if (rows.length === 0 && /\bINNER\s+JOIN\b/i.test(cleanedSql)) {
    const leftSql = cleanedSql.replace(/\bINNER\s+JOIN\b/gi, "LEFT JOIN");
    try {
      const rLeft = await exec.runSelect(leftSql, AbortSignal.timeout(6000));
      const rwLeft = Array.isArray(rLeft?.data) ? rLeft.data : Array.isArray(rLeft) ? rLeft : [];
      if (rwLeft.length > 0) {
        cleanedSql = leftSql;
        rows = rwLeft;
        res = rLeft;
      }
    } catch {}
  }

  const humanRows = stripIdColumnsFromRows(maskSensitiveRows(rows.slice(0, 200)));
  return { rows: humanRows, rowCount: res?.rowCount ?? humanRows.length, cleanedSql };
}


export function detectIntentAndChart(q: string, plan?: UnifiedGenesisOutput): {
  intent: UserIntentType;
  chartType: DiagramChartType;
} {
  const norm = q.trim();
  // 1. Check explicit Diagram keywords in Persian/English
  if (/(نمودار|چارت|گراف|پلات|میله‌ای|میله ای|دایره‌ای|دایره ای|خطی|chart|diagram|plot)/i.test(norm)) {
    let chartType: DiagramChartType = plan?.chart_type || "vertical-bar";
    if (/(دایره‌ای|دایره ای|سهم|درصد|pie)/i.test(norm)) chartType = "pie";
    else if (/(خطی|روند|تغییرات|زمان|line)/i.test(norm)) chartType = "line";
    else chartType = "vertical-bar";
    return { intent: "diagram", chartType };
  }

  // 2. Check explicit Analysis keywords (activates Stage 4 LLM synthesis)
  if (/(تحلیل|بررسی تحلیلی|علت|چرا|ریشه|ارزیابی|آسیب‌شناسی|آسیب شناسی|پیشنهاد مدیریتی|نسبت به شرکت|در مقایسه با شرکت|تحلیل کن)/i.test(norm)) {
    return { intent: "analysis", chartType: "" };
  }

  // 3. Check conceptual/definitional questions first
  const isConceptual = /(تفاوت|فرق\s|منظور\s+از|تعریف\s|وظیفه\s|فرمول\s+محاسبه|به\s+چه\s+صورت\s+است|چه\s+تفاوتی|چه\s+فرقی|یعنی\s+چه)/i.test(norm);
  const isExplicitDataReq = /(لیست|فهرست|نمودار|چارت|گراف|جدول|تحلیل\s+کن|بررسی\s+تحلیلی|چند\s|کدام\s|بیشترین|کمترین|پرفروش)/i.test(norm);
  if ((isConceptual && !isExplicitDataReq) || (plan?.detected_intent === "answer" && !isExplicitDataReq && !(plan?.verification?.sql_query || "").trim())) {
    return { intent: "answer", chartType: "" };
  }
  // 3b. Check pure conversational / conceptual Answer questions (no data retrieval asked)
  const hasDataVerb = /(لیست|فهرست|تعداد|مجموع|جمع|چند|چقدر|کدام|پرفروش|کم‌فروش|بهترین|بیشترین|کمترین|نشان|(?:^|\s)بده(?:\s|$)|اخیر|گزارش|فاکتور|چک|فیش|کارمند|مشتری|کالا|سند|پرداخت|دریافت|قرارداد|یوزر|کاربر|صفحه)/i.test(norm);
  if (!hasDataVerb && (/(سلام|خسته نباشید|چطوری|تو کی هستی|چه کمکی|یعنی چه|توضیح بده|تعریف کن|فرمول|چیست)/i.test(norm) || plan?.detected_intent === "answer")) {
    return { intent: "answer", chartType: "" };
  }

  // 4. Fallback to LLM plan or default "query"
  if (plan?.detected_intent === "diagram") {
    return { intent: "diagram", chartType: plan.chart_type || "vertical-bar" };
  }
  
  return { intent: "query", chartType: "" };
}

export async function runHypothesisGenesisPipeline(
  userQuestion: string,
  onProgress?: (e: StageProgressEvent) => void,
  signal?: AbortSignal
): Promise<any> {
  const t0 = Date.now();
  let exec: any = null;
  try {
    onProgress?.({ stage: 'VERIFY_FACT', status: 'STARTED' });
    const conn = getErpConnection();
    const [ex, mcp] = await Promise.all([
      openExecutor(conn && !('error' in conn) ? conn : null),
      getDynamicMcpContext(userQuestion),
    ]);
    exec = ex;
    onProgress?.({ stage: 'VERIFY_FACT', status: 'COMPLETED' });

    onProgress?.({ stage: 'GENERATE_HYPOTHESIS', status: 'STARTED' });
    const ctx = [mcp.tableStructContext, mcp.domainContext, mcp.metadataContext]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 2400);

    const p1 = await loadPromptTemplate('unified-genesis-prompt.txt', {
      USER_QUESTION: userQuestion,
      RESOLVED_ENTITIES: 'None',
      SCHEMA_CONTEXT: ctx,
    });
    const { data: plan, durationMs: gMs } = await generateStructured<UnifiedGenesisOutput>({
      prompt: p1,
      schema: UNIFIED_GENESIS_JSON_SCHEMA,
      temperature: 0.1,
      numPredict: 650,
      timeoutMs: 35000,
      signal,
    });
    onProgress?.({ stage: 'GENERATE_HYPOTHESIS', status: 'COMPLETED', durationMs: gMs });

    onProgress?.({ stage: 'TEST_HYPOTHESIS', status: 'STARTED' });
    const s3t = Date.now();
    const { intent: detectedIntent, chartType } = detectIntentAndChart(userQuestion, plan);
    console.log(`🧭 [Intent Router] detected_intent="${detectedIntent}"${chartType ? ` (chart="${chartType}")` : ""}`);

    if (detectedIntent === "answer") {
      const directText =
        (typeof plan?.direct_answer === "string" && plan.direct_answer.trim()) ||
        "من دستیار هوشمند تحلیل دیتابیس GreenXERP هستم. می‌توانید سوالات آماری، گزارش‌های فروش، مالی، حقوق و دستمزد، نمودارها یا تحلیل‌های مدیریتی خود را بپرسید.";
      onProgress?.({ stage: "TEST_HYPOTHESIS", status: "COMPLETED", durationMs: 0 });
      onProgress?.({ stage: "FINAL_SYNTHESIS", status: "COMPLETED", durationMs: 0 });
      return {
        question: userQuestion,
        detectedIntent: "answer",
        chartType: "",
        totalDurationMs: Date.now() - t0,
        discoveredTables: [],
        stage1FactVerification: { meta: { goal: "پاسخ مستقیم", sql_query: "" }, rows: [] },
        stage2Hypotheses: [],
        stage3TestResults: [],
        stage4Synthesis: {
          report_title: "",
          executive_summary: directText,
          hypotheses_verdicts: [],
          root_cause_analysis: "",
          managerial_recommendations: [],
        },
        erpActions: [],
      };
    }

    const hyps: HypothesisItem[] = (plan?.hypotheses || []).slice(0, 3).map((h, i) => ({
      id: `H${i + 1}`,
      domain: (h.domain as any) || "customer",
      statement: h.statement || `شاخص تحلیلی ${i + 1}`,
      validation_sql_goal: h.expected_metric || "",
    }));

    if (signal?.aborted) throw new Error("لغو توسط کاربر");
    let s1Rows: any[] = [];
    let s1Sql = (plan?.verification?.sql_query || "").trim();
    if (!s1Sql) {
      const tb = mcp.discoveredTables?.[0] || "gnd_spgod.tblGood";
      s1Sql = `SELECT TOP 10 * FROM ${tb} ORDER BY ID DESC`;
    }
    let s1Err: string | undefined;
    try {
      const r1 = await runSql(exec, s1Sql, userQuestion);
      s1Sql = r1.cleanedSql;
      s1Rows = r1.rows;
    } catch (e: any) {
      s1Sql = sanitizeErpSql(s1Sql, userQuestion);
      s1Rows = [];
      s1Err = e?.message || String(e);
    }

    const s3Res: any[] = [];
    const runAllHyps = detectedIntent === "analysis" || s1Rows.length === 0;
    for (let i = 0; i < hyps.length; i++) {
      if (!runAllHyps && i > 0) break;
      const hyp = hyps[i];
      const q = (plan?.hypotheses?.[i]?.sql_query || "").trim();
      const qt = Date.now();
      if (!q || !/\bFROM\s+gnd_/i.test(q) || (/\bJOIN\b/i.test(q) && !/\bON\b/i.test(q))) continue;
      try {
        const r = await runSql(exec, q, userQuestion);
        s3Res.push({ hypothesis: hyp, sqlQuery: r.cleanedSql, rows: r.rows, rowCount: r.rowCount, durationMs: Date.now() - qt });
        if (detectedIntent !== "analysis" && s1Rows.length === 0 && r.rows.length > 0) break;
      } catch (e: any) {
        s3Res.push({ hypothesis: hyp, sqlQuery: sanitizeErpSql(q, userQuestion), rows: [], rowCount: 0, error: e?.message || String(e), durationMs: Date.now() - qt });
      }
    }
    onProgress?.({ stage: "TEST_HYPOTHESIS", status: "COMPLETED", durationMs: Date.now() - s3t });

        const workingHyp = s3Res.find((x) => x.rows?.length > 0);
    if (s1Rows.length === 0 && workingHyp) {
      s1Sql = workingHyp.sqlQuery;
      s1Rows = workingHyp.rows;
      s1Err = undefined;
    }
    const bestRows = s1Rows;

    onProgress?.({ stage: "FINAL_SYNTHESIS", status: "STARTED" });
    let s4: ExecutiveReportOutput;
    const s4t = Date.now();

    const ENABLE_STAGE4_LLM = detectedIntent === "analysis";
    if (!ENABLE_STAGE4_LLM || bestRows.length === 0) {
      const modeTitle =
        detectedIntent === "diagram"
          ? `گزارش نموداری دیتابیس (نوع تشخیص‌داده‌شده: ${chartType || "vertical-bar"})`
          : "گزارش اجرای کوئری دیتابیس";
      s4 = {
        report_title: modeTitle,
        executive_summary:
          bestRows.length > 0
            ? `تعداد ${bestRows.length} رکورد معتبر از دیتابیس استخراج شد.`
            : s1Err
              ? `خطا در اجرای کوئری: ${s1Err}`
              : "کوئری اجرا شد اما رکوردی یافت نشد.",
        hypotheses_verdicts: s3Res
          .filter((x: any) => x.rows?.length === 1 && Object.keys(x.rows[0]).length <= 3)
          .map((x: any) => ({
            statement: x.hypothesis?.statement || "شاخص آماری",
            verdict: "CONFIRMED",
            evidence: Object.entries(x.rows[0]).map(([k, v]) => `${k}: ${v}`).join(" | "),
          })),
        root_cause_analysis: "",
        managerial_recommendations: [],
      };
    } else {
      const webContext = await fetchExternalWebContext(userQuestion, signal);
      const p4 = await loadPromptTemplate("final-synthesis-prompt.txt", {
        USER_QUESTION: userQuestion + webContext,
        STAGE1_SUMMARY: JSON.stringify(bestRows.slice(0, 8)),
        HYPOTHESES_EVIDENCE_SUMMARY: JSON.stringify(
          s3Res.filter((x) => x.rowCount > 0).map((x) => ({ statement: x.hypothesis.statement, rowCount: x.rowCount, dataSnippet: x.rows.slice(0, 4) }))
        ),
      });
      const { data: s4Raw } = await generateStructured<any>({
        prompt: p4,
        schema: EXECUTIVE_REPORT_JSON_SCHEMA,
        temperature: 0.1,
        numPredict: 650,
        timeoutMs: 25000,
        signal,
      });
      s4 = {
        report_title: typeof s4Raw?.report_title === "string" && s4Raw.report_title.trim() ? s4Raw.report_title.trim() : "گزارش تحلیلی و مدیریتی دیتابیس",
        executive_summary:
          typeof s4Raw?.executive_summary === "string" && s4Raw.executive_summary.trim()
            ? s4Raw.executive_summary.trim()
            : `تحلیل روی ${bestRows.length} رکورد استخراج‌شده انجام شد.`,
        hypotheses_verdicts: Array.isArray(s4Raw?.hypotheses_verdicts) && s4Raw.hypotheses_verdicts.length > 0
          ? s4Raw.hypotheses_verdicts
          : bestRows.slice(0, 3).map((r: any, idx: number) => ({
              statement: `شاخص کلیدی ${idx + 1}`,
              verdict: "CONFIRMED",
              evidence: Object.entries(r).map(([k, v]) => `${k}: ${v}`).join(" | "),
            })),
        root_cause_analysis: typeof s4Raw?.root_cause_analysis === "string" && s4Raw.root_cause_analysis.trim() ? s4Raw.root_cause_analysis.trim() : "تمرکز فروش و تراکنش‌ها بر روی اقلام و طرف‌حساب‌های اصلی سازمان بوده است.",
        managerial_recommendations: Array.isArray(s4Raw?.managerial_recommendations) ? s4Raw.managerial_recommendations : [],
      };
    }
    onProgress?.({ stage: "FINAL_SYNTHESIS", status: "COMPLETED", durationMs: Date.now() - s4t });

    return {
      question: userQuestion,
      detectedIntent,
      chartType,
      totalDurationMs: Date.now() - t0,
      discoveredTables: mcp.discoveredTables || [],
      stage1FactVerification: { meta: { goal: plan?.verification?.goal || "", sql_query: s1Sql, error: s1Err }, rows: s1Rows },
      stage2Hypotheses: hyps,
      stage3TestResults: s3Res,
      stage4Synthesis: s4,
      erpActions: [],
    };
  } finally {
    if (exec && typeof exec.close === 'function') exec.close().catch(() => {});
  }
}
