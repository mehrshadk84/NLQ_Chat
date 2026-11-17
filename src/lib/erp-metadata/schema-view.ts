import type { ParsedSchema, SchemaColumn, SchemaForeignKey, SchemaTable } from "@/types/schema";
import { ancestorsOf, tableKey, type ErpMetadataDocument, type MetaTable } from "./parse";

/*
 * The physical schema implied by an ERP metadata document, in the shape the SQL validator checks
 * against (src/lib/sql-schema/validate-sql.ts):
 *
 *  - each table has only the columns it physically holds: an inherited "@owner" column is a column
 *    of the owner table, reached by joining on ID, never of the inheriting table;
 *  - relationships are the declared FKs (an FK on an inherited column belongs to its owner), the
 *    IS-A links (child.ID = ancestor.ID, for every ancestor, since the key is shared down the chain)
 *    and the ENTITY TREE links (child.<FKcol> = parent.ID);
 *  - the GLOBAL ENTITY KEY view (vwErpEntity) with its documented columns;
 *  - names referenced but not defined stay external: only their referenced columns are known.
 */

export interface ErpKeyRules {
  /** The polymorphic registry view, e.g. gnd_egbse.vwErpEntity. */
  view: string;
  /** "10000000000" in vwErpEntity.ID = CAST(FT AS bigint) * 10000000000 + <table>.ID */
  multiplier: string;
  polymorphicColumn?: string;
  /** FormTypeID by table key, only for participating tables (FT tag and a PK named ID). */
  formTypes: Map<string, number>;
}

const TYPE_NAMES: Record<string, string> = { long: "bigint", string: "nvarchar", guid: "uniqueidentifier", bool: "bit", binary: "varbinary" };

const toColumn = (c: { name: string; type: string; nullable: boolean; identity: boolean; label?: string }): SchemaColumn => ({
  name: c.name,
  type: TYPE_NAMES[c.type] ?? c.type,
  nullable: c.nullable,
  identity: c.identity,
  computed: false,
  ...(c.label && { caption: c.label }),
});

const primaryKey = (t: MetaTable) => t.columns.find((c) => c.primaryKey)?.name;

/**
 * Inherited columns by table: lower-case table name → upper-case column name → the owner table that
 * physically stores it (the "@owner" of the document). Used to tell the model where a column lives.
 */
export type InheritedColumns = Map<string, Map<string, string>>;

export function erpSchemaView(doc: ErpMetadataDocument): { schema: ParsedSchema; keyRules: ErpKeyRules | null; inherited: InheritedColumns } {
  const byKey = new Map(doc.tables.map((t) => [tableKey(t.name), t]));
  const tables: SchemaTable[] = doc.tables.map((t) => ({
    name: t.name,
    ...(t.label && { caption: t.label }),
    columns: t.columns.filter((c) => !c.owner).map(toColumn),
    primaryKey: t.columns.filter((c) => c.primaryKey && !c.owner).map((c) => c.name),
  }));

  const foreignKeys: SchemaForeignKey[] = [];
  const seen = new Set<string>();
  const addFk = (table: string, column: string, refTable: string, refColumn: string, origin: string) => {
    const key = `${tableKey(table)}.${column.toLowerCase()}->${tableKey(refTable)}.${refColumn.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    foreignKeys.push({ name: origin, table, columns: [column], refTable, refColumns: [refColumn] });
  };
  // Columns of undefined tables that the document references (FK targets, @owners): external.
  const externalColumns = new Map<string, Set<string>>();
  const noteExternal = (table: string, column: string) => {
    if (byKey.has(tableKey(table))) return;
    const set = externalColumns.get(table) ?? new Set<string>();
    set.add(column);
    externalColumns.set(table, set);
  };

  for (const t of doc.tables) {
    for (const f of t.foreignKeys) {
      // An FK listed on an inherited column is the owner's FK.
      const owner = t.columns.find((c) => c.name.toLowerCase() === f.column.toLowerCase())?.owner;
      addFk(owner ?? t.name, f.column, f.refTable, f.refColumn, "FK");
      noteExternal(f.refTable, f.refColumn);
      if (owner) noteExternal(owner, f.column);
    }
    for (const c of t.columns) if (c.owner) noteExternal(c.owner, c.name);
    // IS-A: the PK is shared with every ancestor.
    const pk = primaryKey(t);
    if (pk) {
      for (const ancestor of ancestorsOf(t.name, byKey)) {
        const ancestorPk = byKey.get(tableKey(ancestor)) ? primaryKey(byKey.get(tableKey(ancestor))!) : "ID";
        if (ancestorPk) addFk(t.name, pk, ancestor, ancestorPk, "IS-A");
        noteExternal(ancestor, ancestorPk ?? "ID");
      }
    }
  }
  for (const e of doc.entities) {
    for (const child of e.children) {
      if (!child.fkColumn) continue;
      const parent = byKey.get(tableKey(child.parent));
      const parentPk = parent ? primaryKey(parent) : "ID";
      if (parentPk && byKey.has(tableKey(child.table))) addFk(child.table, child.fkColumn, child.parent, parentPk, "ENTITY TREE");
    }
  }

  let keyRules: ErpKeyRules | null = null;
  if (doc.entityKey) {
    const key = doc.entityKey;
    if (!byKey.has(tableKey(key.view))) {
      tables.push({
        name: key.view,
        caption: "GLOBAL ENTITY KEY",
        columns: key.columns.map((c) => toColumn({ name: c.name, type: c.type, nullable: false, identity: false, label: c.description })),
        primaryKey: ["ID"],
      });
    }
    keyRules = {
      view: key.view,
      multiplier: key.multiplier,
      ...(key.polymorphicColumn && { polymorphicColumn: key.polymorphicColumn }),
      formTypes: new Map(
        doc.tables.filter((t) => t.formTypeId !== undefined && primaryKey(t) === "ID").map((t) => [tableKey(t.name), t.formTypeId!]),
      ),
    };
  }

  // External tables with columns known only from references (the validator also derives FK targets).
  for (const [name, columns] of externalColumns) {
    if (doc.tables.some((t) => tableKey(t.name) === tableKey(name))) continue;
    for (const column of columns) {
      // A self-reference keeps the column known to the validator's external-table lookup.
      addFk(name, column, name, column, "external");
    }
  }

  const inherited: InheritedColumns = new Map();
  for (const t of doc.tables) {
    const owned = new Map(t.columns.filter((c) => c.owner).map((c) => [c.name.toUpperCase(), c.owner!]));
    if (owned.size) inherited.set(tableKey(t.name), owned);
  }

  return {
    inherited,
    schema: {
      database: null,
      tables,
      foreignKeys,
      externalTables: [...externalColumns.keys()].sort(),
      issues: doc.issues,
    },
    keyRules,
  };
}
