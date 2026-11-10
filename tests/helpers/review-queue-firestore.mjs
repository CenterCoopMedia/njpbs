// In-memory query fixture: filters, field projections, ordering and limits run
// against supplied records, so a pre-authorization cap can hide real candidates.
export function reviewQueueFirestore(records) {
  const reads = [];
  const fieldValue = (record, field) => field.split(".")
    .reduce((value, key) => value?.[key], record);
  const snapshot = (collection, id, fields) => {
    const stored = records.find((record) => record.collection === collection && record.id === id);
    return { id, exists: Boolean(stored), data: () => stored && Object.fromEntries(
      Object.entries(stored.document).filter(([field]) => fields.includes(field)),
    ) };
  };
  function query(collection, filters = [], fields = [], order = null, limit = Infinity) {
    return {
      where: (field, operator, value) => query(collection, [...filters, { field, operator, value }], fields, order, limit),
      select: (...selected) => query(collection, filters, selected, order, limit),
      orderBy: (field, direction) => query(collection, filters, fields, { field, direction }, limit),
      limit: (value) => query(collection, filters, fields, order, value),
      async get() {
        let matching = records.filter((record) => record.collection === collection && filters.every(
          ({ field, operator, value }) => operator === "in"
            ? value.includes(fieldValue(record.document, field))
            : fieldValue(record.document, field) === value,
        ));
        if (order) {
          matching = matching.filter((record) => fieldValue(record.document, order.field) !== undefined)
            .sort((left, right) => {
              const comparison = String(fieldValue(left.document, order.field))
                .localeCompare(String(fieldValue(right.document, order.field)));
              return order.direction === "desc" ? -comparison : comparison;
            });
        }
        const docs = matching.slice(0, limit).map((record) => snapshot(collection, record.id, fields));
        reads.push({ collection, filters, fields, order, limit, returned: docs.length });
        return { docs };
      },
    };
  }
  return {
    reads,
    collection: (name) => query(name),
    doc: (path) => ({ path }),
    async getAll(...args) {
      const { fieldMask } = args.pop();
      reads.push({ paths: args.map(({ path }) => path), fields: fieldMask });
      return args.map(({ path }) => snapshot(...path.split("/"), fieldMask));
    },
  };
}
