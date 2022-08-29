// This file makes it possible to run "yarn knex migrate:make some_file_name"
// to assist in making new migrations
module.exports = {
  client: 'postgresql',
  connection: {
    database: 'backstage_plugin_catalog',
    host: 'localhost',
    user: '',
    port: 5432,
    password: '',
  },
  useNullAsDefault: true,
  migrations: {
    directory: './migrations',
  },
};
