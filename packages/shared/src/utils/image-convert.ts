import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

type Photon = NonNullable<Awaited<ReturnType<typeof loadPhoton>>>;

function encodePng(photon: Photon, bytes: Uint8Array): Uint8Array | null {
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return image.get_bytes();
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

/** Convert arbitrary image bytes to PNG, which is the only inline format every provider accepts. */
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await loadPhoton();
	if (!photon) return null;
	return encodePng(photon, bytes);
}

/** Convert base64 image data to PNG. Returns null when conversion is unavailable or fails. */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}