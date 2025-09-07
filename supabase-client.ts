/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import {createClient} from '@supabase/supabase-js';

const supabaseUrl = 'https://yddhareinctigsujnkrs.supabase.co';
const supabaseAnonKey =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlkZGhhcmVpbmN0aWdzdWpua3JzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTY1NzcwMDYsImV4cCI6MjA3MjE1MzAwNn0.eZqmCbARg1qNffdrtmGDO5sUUttvdZrAAe9RH9fsGvU';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
