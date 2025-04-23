import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.SUPABASE_URL!
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

/**
 * Checks if a string is a base64 data URL
 */
function isBase64DataUrl(url: string): boolean {
  return url.startsWith("data:")
}

/**
 * Converts a base64 data URL to a Blob
 */
async function base64DataUrlToBlob(dataUrl: string): Promise<Blob> {
  // Extract the MIME type and base64 data
  const matches = dataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/)

  if (!matches || matches.length !== 3) {
    throw new Error("Invalid data URL format")
  }

  const mimeType = matches[1]
  const base64Data = matches[2]

  // Convert base64 to binary
  const binaryString = atob(base64Data)
  const bytes = new Uint8Array(binaryString.length)

  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }

  // Create and return a Blob
  return new Blob([bytes], { type: mimeType })
}

export async function POST(req: NextRequest) {
  try {
    // Validate and parse the JSON body
    const body = await req.json()

    if (!body?.record?.id || !body?.record?.input_image_url || !body?.record?.status) {
      return NextResponse.json({ error: "Invalid payload: Missing required fields" }, { status: 400 })
    }

    const { id, input_image_url, status } = body.record

    // Only process jobs with status === 'pending'
    if (status !== "pending") {
      return NextResponse.json({ message: "Job is not in pending status; no action taken." }, { status: 200 })
    }

    // Fetch the job using the ID from Supabase
    const { data: job, error: fetchError } = await supabase.from("jobs").select("*").eq("id", id).single()

    if (fetchError || !job) {
      return NextResponse.json(
        { error: "Failed to fetch job from Supabase", details: fetchError?.message },
        { status: 500 },
      )
    }

    // Update job to processing status
    await supabase.from("jobs").update({ status: "processing" }).eq("id", id)

    try {
      // Variable to hold our image blob
      let imageBlob: Blob

      // Check if input_image_url is a base64 data URL or a regular URL
      if (isBase64DataUrl(input_image_url)) {
        console.log("Processing base64 data URL")
        // Convert base64 data URL to Blob
        imageBlob = await base64DataUrlToBlob(input_image_url)
      } else {
        console.log("Processing image URL:", input_image_url)
        // Download the image from input_image_url
        const imageResponse = await fetch(input_image_url)
        if (!imageResponse.ok) {
          throw new Error(`Failed to download input image: ${imageResponse.statusText}`)
        }
        imageBlob = await imageResponse.blob()
      }

      // Prepare FormData for OpenAI API
      const formData = new FormData()
      formData.append("image", imageBlob, "input.png")
      formData.append("n", "1")
      formData.append("size", "1024x1024")

      // Call OpenAI's image variations API
      const openAIResponse = await fetch("https://api.openai.com/v1/images/variations", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: formData,
      })

      if (!openAIResponse.ok) {
        const errorText = await openAIResponse.text()
        throw new Error(`OpenAI API error: ${openAIResponse.status} ${errorText}`)
      }

      const openAIResult = await openAIResponse.json()
      const resultImageUrl = openAIResult?.data?.[0]?.url

      if (!resultImageUrl) {
        throw new Error("OpenAI API did not return a result image URL")
      }

      // Update the job status to 'complete' with the result image URL
      const { error: updateError } = await supabase
        .from("jobs")
        .update({
          status: "complete",
          result_image_url: resultImageUrl,
          processed_at: new Date().toISOString(),
        })
        .eq("id", id)

      if (updateError) {
        throw new Error(`Failed to update job in Supabase: ${updateError.message}`)
      }

      return NextResponse.json(
        { message: "Job processed successfully", result_image_url: resultImageUrl },
        { status: 200 },
      )
    } catch (processError) {
      console.error("Processing error:", processError)

      // Update the job status to 'failed' with an error message
      await supabase
        .from("jobs")
        .update({
          status: "failed",
          error_message: processError instanceof Error ? processError.message : String(processError),
          processed_at: new Date().toISOString(),
        })
        .eq("id", id)

      return NextResponse.json(
        {
          error: "Job processing failed",
          details: processError instanceof Error ? processError.message : String(processError),
        },
        { status: 500 },
      )
    }
  } catch (error) {
    console.error("Webhook handler error:", error)
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    )
  }
}
