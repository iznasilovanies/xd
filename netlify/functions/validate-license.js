// netlify/functions/validate-license.js
const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    // Parse request body
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
    } catch (parseError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          valid: false, 
          error: 'Invalid JSON in request body',
          details: parseError.message
        })
      };
    }

    const { licenseKey, hwid } = requestBody;

    if (!licenseKey || !hwid) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          valid: false, 
          error: 'Missing licenseKey or hwid',
          received: { licenseKey: !!licenseKey, hwid: !!hwid }
        })
      };
    }

    // Initialize Supabase client
    const supabaseUrl = process.env.SUPABASE_URL || 'https://jscjyhrjnxrvopxqsiow.supabase.co';
    const supabaseKey = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpzY2p5aHJqbnhydm9weHFzaW93Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjUyODc0OCwiZXhwIjoyMDc4MTA0NzQ4fQ.L1BynSr0WJBuAb0FrAU48j_5p7INCrjVz-E9hzz_kws';
    
    if (!supabaseUrl || !supabaseKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          valid: false, 
          error: 'Supabase configuration missing',
          hasUrl: !!supabaseUrl,
          hasKey: !!supabaseKey
        })
      };
    }
    
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Check license in database
    const { data: license, error } = await supabase
      .from('licenses')
      .select('*')
      .eq('license_key', licenseKey)
      .single();

    if (error) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ 
          valid: false, 
          error: 'License not found',
          details: error.message,
          code: error.code
        })
      };
    }

    if (!license) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ 
          valid: false, 
          error: 'License not found',
          details: 'No license found with the provided key'
        })
      };
    }

    // Check if license is active
    if (!license.is_active) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ 
          valid: false, 
          error: 'License is deactivated' 
        })
      };
    }

    // Check expiration
    const expiresAt = new Date(license.expires_at);
    const now = new Date();
    
    if (expiresAt < now) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ 
          valid: false, 
          error: 'License expired',
          expires_at: license.expires_at
        })
      };
    }

    // Check HWID binding
    if (license.hwid && license.hwid !== hwid) {
      // HWID mismatch - check if this is first activation
      if (!license.hwid || license.hwid === '') {
        // First activation - bind HWID
        await supabase
          .from('licenses')
          .update({ 
            hwid: hwid,
            activated_at: new Date().toISOString(),
            last_check: new Date().toISOString()
          })
          .eq('license_key', licenseKey);
      } else {
        // HWID mismatch - license already bound to different machine
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({ 
            valid: false, 
            error: 'License is bound to different hardware',
            message: 'This license is already activated on another computer'
          })
        };
      }
    } else {
      // Update last check time
      await supabase
        .from('licenses')
        .update({ last_check: new Date().toISOString() })
        .eq('license_key', licenseKey);
    }

    // Generate JWT token for offline validation (simple base64 for now)
    const token = Buffer.from(JSON.stringify({
      licenseKey,
      hwid,
      expires_at: license.expires_at,
      timestamp: Date.now()
    })).toString('base64');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        expires_at: license.expires_at,
        token: token,
        user_email: license.user_email || null
      })
    };

  } catch (error) {
    console.error('Error validating license:', error);
    const errorResponse = {
      valid: false,
      error: 'Internal server error',
      message: error.message || 'Unknown error'
    };
    
    // Include stack trace in development
    if (process.env.NODE_ENV === 'development' || process.env.NETLIFY_DEV) {
      errorResponse.stack = error.stack;
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify(errorResponse)
    };
  }
};
