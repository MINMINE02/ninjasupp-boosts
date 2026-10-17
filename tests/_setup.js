'use strict';
// Tests run without a database or network: the Supabase client is replaced by an empty stub.
const Module = require('module');
const orig = Module._load;
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test';
Module._load = function (request, ...rest) {
  if (request === '@supabase/supabase-js') {
    return { createClient: () => global.__fakeDb || ({ from() { throw new Error('no database in tests'); } }) };
  }
  return orig.call(this, request, ...rest);
};
