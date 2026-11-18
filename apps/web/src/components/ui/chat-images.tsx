import { useEffect, useRef, useState } from "react"
import { Camera, ImagePlus, X } from "lucide-react"
import { CHAT_IMAGE_TYPES, MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, chatImageUrl, type ChatImage } from "../../../../../packages/chat-images"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { PromptInputAction } from "@/components/ui/prompt-input"

export function ChatImages({ images, onRemove }: { images: ChatImage[]; onRemove?: (index: number) => void }) {
  if (!images.length) return null
  return (
    <div className="flex flex-wrap gap-2 p-1" aria-label="Attached images">
      {images.map((image, index) => (
        <div key={index} className="relative">
          <Dialog>
            <DialogTrigger asChild>
              <button type="button" aria-label={`View ${image.name}`} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-ring">
                <img src={chatImageUrl(image)} alt={image.name} className="size-24 rounded-lg border border-border object-cover" />
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogTitle className="truncate pr-8 text-lg">{image.name}</DialogTitle>
              <DialogDescription className="sr-only">Image attachment preview</DialogDescription>
              <img src={chatImageUrl(image)} alt={image.name} className="max-h-[70dvh] w-full object-contain" />
            </DialogContent>
          </Dialog>
          {onRemove ? (
            <button type="button" aria-label={`Remove ${image.name}`} title={`Remove ${image.name}`}
              className="absolute -top-1 -right-1 grid size-6 place-items-center rounded-full border border-border bg-card text-foreground shadow-sm focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => onRemove(index)}>
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

async function readImage(file: File): Promise<ChatImage> {
  if (!CHAT_IMAGE_TYPES.includes(file.type)) throw new Error("Choose a JPEG, PNG, WebP or GIF image.")
  if (!file.size || file.size > MAX_CHAT_IMAGE_BYTES) throw new Error("Each image must be between 1 byte and 5 MB.")
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(",")[1])
    reader.onerror = () => reject(new Error(`Could not read ${file.name}. Try choosing it again.`))
    reader.readAsDataURL(file)
  })
  return { name: file.name.slice(0, 255), mimeType: file.type, data }
}

export function ChatImageControls({ images, onChange, disabled, onBusyChange, onError }: {
  images: ChatImage[]
  onChange: (images: ChatImage[]) => void
  disabled: boolean
  onBusyChange: (busy: boolean) => void
  onError: (error: string) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [cameraOpen, setCameraOpen] = useState(false)
  const busyRef = useRef(false)
  const unavailable = disabled || images.length >= MAX_CHAT_IMAGES

  const addFiles = async (files: File[]) => {
    if (!files.length || busyRef.current || disabled) return
    onError("")
    if (images.length + files.length > MAX_CHAT_IMAGES) {
      onError(`Attach up to ${MAX_CHAT_IMAGES} images per message.`)
      return
    }
    busyRef.current = true
    onBusyChange(true)
    try {
      const added = await Promise.all(files.map(readImage))
      onChange([...images, ...added])
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not read the image.")
    } finally {
      busyRef.current = false
      onBusyChange(false)
    }
  }

  return (
    <>
      <input ref={inputRef} className="hidden" type="file" accept={CHAT_IMAGE_TYPES.join(",")} multiple aria-label="Choose images"
        disabled={unavailable} onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ""
          void addFiles(files)
        }} />
      <PromptInputAction label="Upload images" icon={ImagePlus} disabled={unavailable} onClick={() => inputRef.current?.click()} />
      <PromptInputAction label="Take a photo" icon={Camera} disabled={unavailable} onClick={() => setCameraOpen(true)} />
      {cameraOpen ? <CameraCapture onClose={() => setCameraOpen(false)} onCapture={(file) => {
        setCameraOpen(false)
        void addFiles([file])
      }} /> : null}
    </>
  )
}

function CameraCapture({ onClose, onCapture }: { onClose: () => void; onCapture: (file: File) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState("")
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let disposed = false
    let stream: MediaStream | undefined
    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires HTTPS or localhost and a supported browser. You can upload a photo instead.")
        const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
        if (disposed) {
          acquired.getTracks().forEach((track) => track.stop())
          return
        }
        stream = acquired
        if (videoRef.current) videoRef.current.srcObject = acquired
      } catch (reason) {
        if (disposed) return
        const name = reason instanceof Error ? reason.name : ""
        setError(name === "NotAllowedError" ? "Camera access was denied. Allow camera access in your browser or upload a photo."
          : name === "NotFoundError" ? "No camera was found. You can upload a photo instead."
          : reason instanceof Error ? reason.message : "Could not open the camera. You can upload a photo instead.")
      }
    }
    void start()
    return () => {
      disposed = true
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  const capture = () => {
    const video = videoRef.current
    if (!video?.videoWidth || !video.videoHeight) return
    const canvas = document.createElement("canvas")
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const context = canvas.getContext("2d")
    if (!context) {
      setError("Could not capture a photo. You can upload one instead.")
      return
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    canvas.toBlob((blob) => {
      if (!blob) {
        setError("Could not capture a photo. Please try again.")
        return
      }
      onCapture(new File([blob], `photo-${Date.now()}.jpg`, { type: "image/jpeg" }))
    }, "image/jpeg", 0.9)
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Take a photo</DialogTitle>
          <DialogDescription>Capture a photo to attach to your message. It sends when you press Send.</DialogDescription>
        </DialogHeader>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        <video ref={videoRef} autoPlay playsInline muted aria-label="Camera preview" className="aspect-video w-full rounded-lg bg-black object-contain"
          onLoadedData={() => setReady(true)} />
        {!ready && !error ? <p role="status" className="text-sm text-muted-foreground">Waiting for camera access…</p> : null}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button onClick={capture} disabled={!ready || !!error}><Camera className="size-4" />Use photo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
