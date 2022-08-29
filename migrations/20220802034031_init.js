/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function (knex) {
  return (
    knex.schema
      .createTable('entity_certificates', table => {
        table.comment('Entity certificates');
        table
          .uuid('id')
          .primary()
          .notNullable()
          .comment('Auto-generated ID of the certificate');

        table.string('entity_name').notNullable().comment('Entity name');

        table
          .timestamp('created_at', { useTz: false, precision: 0 })
          .notNullable()
          .defaultTo(knex.fn.now())
          .comment('The creation time of the cert')

        table.boolean('use_server_certificate').defaultTo(false);
      })
      .createTable('certificate_files', table => {
        table.uuid('certificate_id').notNullable();

        table
          .timestamp('created_at', { useTz: false, precision: 0 })
          .notNullable()
          .defaultTo(knex.fn.now())
          .comment('The creation time of the cert');
          
        table.string('file_name').notNullable();
        table.string('file_path');

        table.enum('type', ['rootCert', 'privateKey', 'certChain']).notNullable().comment("Cert file type");

        table.primary(['certificate_id', 'type']);

        table.text('file_content').comment('Hashed file content');
      })
  );
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function (knex) {
  return (
    knex.schema
      .dropTableIfExists('entity_certificates')
      .dropTableIfExists('certificate_files')
  );
};
