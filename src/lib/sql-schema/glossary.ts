/**
 * Domain terms that point to tables, in addition to the table and column captions already in
 * the schema file (which cover most Persian terms). Edit freely: entries naming tables that
 * aren't in the uploaded schema are ignored, so nothing here can add a table or relationship.
 *
 * A term mapped to one table selects it. A term mapped to several tables only makes them
 * candidates: if nothing else in the question decides between them, the user is asked which
 * one they mean.
 */
export interface GlossaryEntry {
  terms: string[];
  tables: string[];
}

export const SCHEMA_GLOSSARY: GlossaryEntry[] = [
  {
    terms: ["پرسنل", "کارکنان", "کارمندان", "نیروی انسانی", "employee", "employees", "staff", "personnel"],
    tables: ["gnd_hrprs.tblEmployee"],
  },
  {
    terms: ["حقوق", "دستمزد", "salary", "salaries", "payroll", "wage", "wages"],
    tables: ["gnd_hrpyr.tblSalaryBill", "gnd_hrpyr.tblSalaryList"],
  },
  { terms: ["payslip", "pay slip", "فیش"], tables: ["gnd_hrpyr.tblSalaryBill"] },
  { terms: ["مرخصی", "leave"], tables: ["gnd_hrcio.tblEmployeeSavedLeave"] },
  { terms: ["mission", "ماموریت"], tables: ["gnd_hrcio.tblEmployeeMission"] },
  { terms: ["حکم", "work order"], tables: ["gnd_hrprs.tblWorkOrder"] },
  { terms: ["education", "تحصیلات", "مدرک"], tables: ["gnd_hrprs.tblEmployeeEducation"] },
  { terms: ["family", "خانواده"], tables: ["gnd_hrprs.tblEmployeeFamily"] },
  {
    terms: ["آموزش", "دوره", "training", "course", "courses"],
    tables: ["gnd_hrtrn.tblTrainingCourse", "gnd_hrtrn.tblTrainingPlan"],
  },
];
