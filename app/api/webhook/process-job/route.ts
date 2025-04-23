import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export async function POST(req: NextRequest) {
  try {
    // Validate and parse the JSON body
    const body = await req.json();

    if (!body?.record?.id || !body?.record?.input_image_url || !body?.record?.status) {
      return NextResponse.json(
        { error: 'Invalid payload: Missing required fields' },
        { status: 400 }
      );
    }

    const { id, input_image_url, status } = body.record;

    // Only process jobs with status === 'pending'
    if (status !== 'pending') {
      return NextResponse.json(
        { message: 'Job is not in pending status; no action taken.' },
        { status: 200 }
      );
    }

    // Fetch the job using the ID from Supabase
    const { data: job, error: fetchError } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !job) {
      return NextResponse.json(
        { error: 'Failed to fetch job from Supabase', details: fetchError?.message },
        { status: 500 }
      );
    }

    // Update job to processing status
    await supabase
      .from('jobs')
      .update({ status: 'processing' })
      .eq('id', id);

    try {
      // Download the image from input_image_url
      const imageResponse = await fetch(input_image_url);
      if (!imageResponse.ok) {
        throw new Error(`Failed to download input image: ${imageResponse.statusText}`);
      }
      const imageBlob = await imageResponse.blob();

      // Prepare FormData for OpenAI API
      const formData = new FormData();
      formData.append('image', imageBlob, 'image.png');
      formData.append('n', '1');
      formData.append('size', '1024x1024');

      // Call OpenAI's image variations API
      const openAIResponse = await fetch('https://api.openai.com/v1/images/variations', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`
        },
        body: formData
      });

      if (!openAIResponse.ok) {
        const errorText = await openAIResponse.text();
        throw new Error(`OpenAI API error: ${openAIResponse.status} ${errorText}`);
      }

      const openAIResult = await openAIResponse.json();
      const resultImageUrl = openAIResult?.data?.[0]?.url;

      if (!resultImageUrl) {
        throw new Error('OpenAI API did not return a result image URL');
      }

      // Update the job status to 'complete' with the result image URL
      const { error: updateError } = await supabase
        .from('jobs')
        .update({ status: 'complete', result_image_url: resultImageUrl })
        .eq('id', id);

      if (updateError) {
        throw new Error(`Failed to update job in Supabase: ${updateError.message}`);
      }

      return NextResponse.json(
        { message: 'Job processed successfully', result_image_url: resultImageUrl },
        { status: 200 }
      );
    } catch (processError) {
      // Update the job status to 'failed' with an error message
      await supabase
        .from('jobs')
        .update({ status: 'failed', error_message: processError.message })
        .eq('id', id);

      return NextResponse.json(
        { error: 'Job processing failed', details: processError.message },
        { status: 500 }
      );
    }
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error', details: error.message },
      { status: 500 }
    );
  }
}
