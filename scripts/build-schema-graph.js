const fs = require("fs");
const path = require("path");
const sql = require("mssql");

const norm = (s) => (s || "").replace(/\u200c/g, " ").replace(/[ي]/g, "ی").replace(/[ك]/g, "ک").replace(/\s+/g, " ").trim();

const env = fs.readFileSync(".env.local", "utf8");
const getEnv = (k) => env.match(new RegExp(`^${k}\\s*=\\s*["']?([^"'\\r\\n]+)`, "m"))?.[1]?.trim();
const [server, portStr] = (getEnv("ERP_SERVER") || "127.0.0.1,1433").split(",");

async function build() {
  const pool = await sql.connect({
    server,
    port: Number(portStr) || 1433,
    database: getEnv("ERP_DATABASE"),
    user: getEnv("ERP_USERNAME"),
    password: getEnv("ERP_PASSWORD"),
    options: { encrypt: false, trustServerCertificate: true },
  });

  const tables = {};
  const ensureTbl = (name) => {
    if (!tables[name]) {
      tables[name] = { name, label: "", ft: "", parent: "", rowCount: 0, cols: {}, colLabels: {}, edges: [] };
    }
    return tables[name];
  };
  const addEdge = (from, to, fromCol, toCol, rel) => {
    if (!from || !to || from === to) return;
    const t1 = ensureTbl(from), t2 = ensureTbl(to);
    if (!t1.edges.some((e) => e.to === to && e.fromCol === fromCol && e.toCol === toCol)) {
      t1.edges.push({ to, fromCol, toCol, rel });
    }
    if (!t2.edges.some((e) => e.to === from && e.fromCol === toCol && e.toCol === fromCol)) {
      t2.edges.push({ to: from, fromCol: toCol, toCol: fromCol, rel: rel === "CHILD" ? "PARENT" : rel });
    }
  };

  const colRes = await pool.request().query(`
    SELECT s.name + '.' + t.name AS tbl, c.name AS col, ty.name AS dtype
    FROM sys.tables t
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.columns c ON t.object_id = c.object_id
    JOIN sys.types ty ON c.user_type_id = ty.user_type_id
    WHERE s.name LIKE 'gnd[_]%' AND t.name LIKE 'tbl%'
    ORDER BY tbl, c.column_id
  `);
  for (const r of colRes.recordset) {
    ensureTbl(r.tbl).cols[r.col] = r.dtype;
  }

  const rowRes = await pool.request().query(`
    SELECT s.name + '.' + t.name AS tbl, SUM(p.rows) AS cnt
    FROM sys.tables t
    JOIN sys.schemas s ON t.schema_id = s.schema_id
    JOIN sys.partitions p ON t.object_id = p.object_id AND p.index_id IN (0, 1)
    WHERE s.name LIKE 'gnd[_]%' AND t.name LIKE 'tbl%'
    GROUP BY s.name, t.name
  `);
  for (const r of rowRes.recordset) {
    ensureTbl(r.tbl).rowCount = Number(r.cnt) || 0;
  }

  const fkRes = await pool.request().query(`
    SELECT s1.name + '.' + t1.name AS fTbl, c1.name AS fCol,
           s2.name + '.' + t2.name AS tTbl, c2.name AS tCol
    FROM sys.foreign_key_columns fkc
    JOIN sys.tables t1 ON fkc.parent_object_id = t1.object_id
    JOIN sys.schemas s1 ON t1.schema_id = s1.schema_id
    JOIN sys.columns c1 ON fkc.parent_object_id = c1.object_id AND fkc.parent_column_id = c1.column_id
    JOIN sys.tables t2 ON fkc.referenced_object_id = t2.object_id
    JOIN sys.schemas s2 ON t2.schema_id = s2.schema_id
    JOIN sys.columns c2 ON fkc.referenced_object_id = c2.object_id AND fkc.referenced_column_id = c2.column_id
    WHERE s1.name LIKE 'gnd[_]%' AND s2.name LIKE 'gnd[_]%'
  `);
  for (const r of fkRes.recordset) {
    if (tables[r.fTbl] && tables[r.tTbl]) addEdge(r.fTbl, r.tTbl, r.fCol, r.tCol, "FK");
  }

  const bakPath = fs.existsSync("data/ai-table-list.txt.bak") ? "data/ai-table-list.txt.bak" : "data/ai-table-list.txt";
  const raw = fs.readFileSync(bakPath, "utf8");
  let stack = [];
  let curTbl = null;

  for (const line of raw.split(/\r?\n/)) {
    const em = line.match(/^E\s+(\d+)\s+(gnd_[a-z0-9_]+\.tbl[A-Za-z0-9_]+)\s+\[([^\]]+)\](?:\s+\^(gnd_[a-z0-9_]+\.tbl[A-Za-z0-9_]+))?/);
    if (em && tables[em[2]]) {
      const t = tables[em[2]];
      t.ft = em[1];
      t.label = norm(em[3]);
      if (em[4] && tables[em[4]]) {
        t.parent = em[4];
        addEdge(t.name, em[4], "ID", "ID", "IS-A");
      }
      stack = [{ indent: 0, name: t.name }];
      curTbl = t;
      continue;
    }
    const cm = line.match(/^(\s*)>\s+(gnd_[a-z0-9_]+\.tbl[A-Za-z0-9_]+)(?:\s+\(([^)]+)\))?/);
    if (cm && stack.length > 0 && tables[cm[2]]) {
      const indent = cm[1].length;
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parentName = stack[stack.length - 1].name;
      const fk = (cm[3] || "ID").trim();
      addEdge(cm[2], parentName, fk, "ID", "FK");
      if (!tables[cm[2]].label && tables[parentName]?.label) {
        tables[cm[2]].label = norm(tables[parentName].label + " جزئیات");
      }
      stack.push({ indent, name: cm[2] });
      continue;
    }
    const hdr = line.match(/^(?:TABLE\s+)?(gnd_[a-z0-9_]+\.tbl[A-Za-z0-9_]+)\b/);
    if (hdr && tables[hdr[1]]) {
      curTbl = tables[hdr[1]];
      const lbl = line.match(/\[([^\]]+)\]/)?.[1];
      if (lbl && !curTbl.label) curTbl.label = norm(lbl);
      const isa = line.match(/(?:\^|IS-A\s+)(gnd_[a-z0-9_]+\.tbl[A-Za-z0-9_]+)/)?.[1];
      if (isa && tables[isa]) {
        curTbl.parent = isa;
        addEdge(curTbl.name, isa, "ID", "ID", "IS-A");
      }
    }
    if (curTbl) {
      for (const m of line.matchAll(/\b([A-Za-z0-9_]+):[A-Za-z0-9_?]+(?:[^":\n]*?)"([^"]+)"/g)) {
        const cName = m[1], cLbl = norm(m[2]);
        if (curTbl.cols[cName]) curTbl.colLabels[cName] = cLbl;
        else if (curTbl.cols[cName + "ID"]) curTbl.colLabels[cName + "ID"] = cLbl;
      }
      for (const fk of line.matchAll(/\b([A-Za-z0-9_]+)->(gnd_[a-z0-9_]+\.tbl[A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?/g)) {
        const fCol = fk[1], target = fk[2], tCol = fk[3] || "ID";
        if (tables[target]) {
          const realCol = curTbl.cols[fCol] ? fCol : curTbl.cols[fCol + "ID"] ? fCol + "ID" : fCol;
          if (curTbl.cols[realCol]) addEdge(curTbl.name, target, realCol, tCol, "FK");
        }
      }
    }
  }


  const erpColDict = {
    Farsi: "نام فارسی", Name: "نام", Title: "عنوان", Code: "کد", Description: "شرح توضیحات",
    GoodCode: "کد کالا", EmployeeCode: "کد پرسنلی کارمند", FatherName: "نام پدر",
    EmploymentDate: "تاریخ استخدام", Mobile: "شماره موبایل", OfficePhone: "تلفن دفتر",
    Username: "نام کاربری یوزر", SysUserName: "نام کاربری سیستم", IsActive: "فعال", IsRemoved: "حذف شده",
    DoneDate: "تاریخ ثبت", ExecuteDate: "تاریخ سررسید", PayRequestDate: "تاریخ درخواست پرداخت",
    PageDate: "تاریخ صفحه", VisitDate: "تاریخ بازدید سایت", UniqePageName: "نام یکتای صفحه",
    AccValue: "مبلغ", TotalSoldValue: "مبلغ کل فروش", DetailTotalAfterDiscount: "مبلغ نهایی پس از تخفیف",
    TotalDiscount: "مجموع تخفیف", DiscountValue: "مبلغ تخفیف", Qty: "تعداد مقدار", UnitPrice: "قیمت واحد",
    ChequeNumber: "شماره چک", AccountNumber: "شماره حساب بانکی", BankAccountName: "نام حساب بانکی",
    HoghugheMahiane: "حقوق ماهیانه", MaliateHoghugh: "مالیات حقوق", HagheBimeSahmKarmand: "حق بیمه سهم کارمند",
    MandeGhabelePardakht: "مانده قابل پرداخت خالص دریافتی", EzafeKar: "اضافه کار", Bahrevari: "پاداش بهره وری",
    KasrKar: "کسر کار کسورات", HagheMaskan: "حق مسکن", HagheOlad: "حق اولاد", Sanavat: "پایه سنوات",
    ChrisDate: "تاریخ میلادی", ParsDate: "تاریخ شمسی", ParsYear: "سال شمسی", ParsMonth: "ماه شمسی",
    ParsMonthName: "نام ماه شمسی", ParsDayName: "نام روز هفته شمسی", DayOfWeek: "شماره روز هفته"
  };

  for (const t of Object.values(tables)) {
    if (t.name.endsWith(".tblPage") && !t.label) t.label = "صفحه وب سایت";
    for (const col of Object.keys(t.cols)) {
      if (!t.colLabels[col] && erpColDict[col]) t.colLabels[col] = erpColDict[col];
      if (/EmployeeID$/i.test(col)) addEdge(t.name, "gnd_hrprs.tblEmployee", col, "ID", "FK");
      if (/(CustomerID|PersonID|ContactID|SalesManID|ContractorID)$/i.test(col)) addEdge(t.name, "gnd_egbse.tblContact", col, "ID", "FK");
      if (/ContactMemberID$/i.test(col)) addEdge(t.name, "gnd_egbse.tblContactMember", col, "ID", "FK");
      if (/DepartmentID$/i.test(col)) addEdge(t.name, "gnd_egbse.tblDepartment", col, "ID", "FK");
      if (/ProjectID$/i.test(col)) addEdge(t.name, "gnd_pjprj.tblProject", col, "ID", "FK");
      if (/AccountID$/i.test(col) && !/BankAccountID$/i.test(col)) addEdge(t.name, "gnd_fiaci.tblAccount", col, "ID", "FK");
      if (/GoodID$/i.test(col)) addEdge(t.name, "gnd_spgod.tblGood", col, "ID", "FK");
      if (/GoodGroupID$/i.test(col)) addEdge(t.name, "gnd_spgod.tblGoodGroup", col, "ID", "FK");
      if (/BankBrandID$/i.test(col)) addEdge(t.name, "gnd_firpd.tblBankBrand", col, "ID", "FK");
      if (/UserID$/i.test(col)) addEdge(t.name, "gnd_egbse.tblUser", col, "ID", "FK");
      if (/WebsiteID$/i.test(col)) addEdge(t.name, "gnd_grweb.tblWebSite", col, "ID", "FK");
    }
  }

  fs.writeFileSync("data/schema-graph.json", JSON.stringify({ generatedAt: new Date().toISOString(), tables }, null, 2));
  const totalT = Object.keys(tables).length;
  const nonEmptyT = Object.values(tables).filter((t) => t.rowCount > 0).length;
  const totalEdges = Object.values(tables).reduce((s, t) => s + t.edges.length, 0);
  console.log(`✅ schema-graph.json built: ${totalT} tables (${nonEmptyT} with rows), ${totalEdges} graph edges.`);
  await pool.close();
}
build().catch((e) => { console.error(e); process.exit(1); });
