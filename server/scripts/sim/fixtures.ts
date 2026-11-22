/**
 * Sim fixtures — generated in-process so we don't ship binaries in the
 * repo. Two artifacts:
 *
 *   - A fillable school-form PDF with AcroForm fields, used by the
 *     form-fill scenarios. Mirrors the shape `forms.test.ts` builds.
 *   - A tiny PNG used by the screenshot-classify scenario. The image
 *     itself is meaningless to a human but the LLM's vision pass over a
 *     real screenshot is what we're really testing in non-mock mode —
 *     in mock mode the verifier just checks the upload landed.
 */
import { PDFDocument } from 'pdf-lib';

export async function buildSchoolFormFixture(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 800]);
  const form = pdf.getForm();
  const text = (name: string, y: number) => {
    const f = form.createTextField(name);
    f.setText('');
    f.addToPage(page, { x: 50, y, width: 280, height: 16 });
  };
  text('Student.Name', 760);
  text('Student.DOB', 740);
  text('Student.Allergies', 720);
  text('Parent.Name', 690);
  text('Parent.Phone', 670);
  text('Emergency.Contact.Name', 640);
  text('Insurance.Provider', 610);
  text('Insurance.MemberID', 590);
  text('Physician.Name', 560);
  text('Physician.Phone', 540);
  const consent = form.createCheckBox('Consent.PhotoRelease');
  consent.addToPage(page, { x: 50, y: 510, width: 16, height: 16 });
  return Buffer.from(await pdf.save());
}

/**
 * Smallest valid PNG — a 1×1 transparent pixel. The content_classifier
 * will short-circuit (low OCR signal) on this, which is the desired
 * mock-mode behaviour. In non-mock mode you'd swap in a real screenshot
 * fixture before running the sim — see `runScreenshotScenario` in
 * `run.ts` for the override hook.
 */
export function tinyPng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
    'base64',
  );
}
