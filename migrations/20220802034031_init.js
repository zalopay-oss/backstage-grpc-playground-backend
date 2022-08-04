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
          .comment('The creation time of the cert');

        table
          .timestamp('updated_at', { useTz: false, precision: 0 })
          .comment('The update time of the cert');
          
        // table.string('root_cert_path');
        // table.string('root_cert_name');
        // table.text('root_cert_content').comment('Hashed root cert content');

        // table.string('private_key_path');
        // table.string('private_key_name');
        // table.text('private_key_content').comment('Hashed private key content');

        // table.string('cert_chain_path');
        // table.string('cert_chain_name');
        // table.text('cert_chain_content').comment('Hashed cert chain content');

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
