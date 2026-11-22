// A data migration: @cyphra/testing's applySchema runs it once (recorded on __CyphraMigration).
export default {
  name: "001_tst_settings",
  async up({ db }) {
    await db.run`MERGE (s:TstSetting {key: ${"theme"}}) SET s.value = ${"dark"}`;
  },
};
