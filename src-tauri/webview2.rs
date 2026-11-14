//! What only WebView2 offers, through its own API (Windows): the right-click item that searches
//! るりま, and the picture of a page drawn behind the windows over it. Pages are not touched.
use tauri::{Emitter, Manager};

/// Adds 「るりまを全文検索」 to the right-click menu of a webview when text is selected; choosing
/// it sends the text to the screen as `rurima-search` (D3). Tauri has no menu of its own for
/// this, so the item goes into WebView2's menu. The page itself is not touched.
pub fn add_search_menu(webview: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Environment9, ICoreWebView2_11, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
    };
    use webview2_com::{
        take_pwstr, ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler,
    };
    use windows_core::{Interface, BOOL, HSTRING, PWSTR};
    let app = webview.app_handle().clone();
    let added = webview.with_webview(move |platform| unsafe {
        let core = platform
            .controller()
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_11>());
        let environment = platform.environment().cast::<ICoreWebView2Environment9>();
        let (Ok(core), Ok(environment)) = (core, environment) else {
            eprintln!("this WebView2 cannot add to the right-click menu");
            return;
        };
        let handler = ContextMenuRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                return Ok(());
            };
            let target = args.ContextMenuTarget()?;
            let mut selected = BOOL::default();
            target.HasSelection(&mut selected)?;
            if !selected.as_bool() {
                return Ok(());
            }
            let mut text = PWSTR::null();
            target.SelectionText(&mut text)?;
            let text = take_pwstr(text);
            let item = environment.CreateContextMenuItem(
                &HSTRING::from("るりまを全文検索"),
                None::<&windows::Win32::System::Com::IStream>,
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
            )?;
            let app = app.clone();
            let chosen = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                let _ = app.emit_to("main", "rurima-search", &text);
                Ok(())
            }));
            let mut token = 0;
            item.add_CustomItemSelected(&chosen, &mut token)?;
            let items = args.MenuItems()?;
            let mut count = 0;
            items.Count(&mut count)?;
            items.InsertValueAtIndex(count, &item)
        }));
        let mut token = 0;
        if let Err(error) = core.add_ContextMenuRequested(&handler, &mut token) {
            eprintln!("cannot add to the right-click menu: {error}");
        }
    });
    if let Err(error) = added {
        eprintln!("cannot add to the right-click menu: {error}");
    }
}

/// Sends the JPEG bytes of the page, or nothing when it cannot be taken.
pub fn capture(
    platform: tauri::webview::PlatformWebview,
    sender: std::sync::mpsc::Sender<Vec<u8>>,
) {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG;
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    use windows::Win32::UI::Shell::SHCreateMemStream;
    let taken = unsafe {
        (|| -> windows_core::Result<()> {
            let core = platform.controller().CoreWebView2()?;
            let stream = SHCreateMemStream(None).ok_or_else(windows_core::Error::empty)?;
            let target = stream.clone();
            let send = sender.clone();
            let done = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                let mut bytes = Vec::new();
                if result.is_ok() && target.Seek(0, STREAM_SEEK_SET, None).is_ok() {
                    let mut buffer = [0u8; 64 * 1024];
                    loop {
                        let mut read = 0u32;
                        let status = target.Read(
                            buffer.as_mut_ptr().cast(),
                            buffer.len() as u32,
                            Some(&mut read),
                        );
                        if status.is_err() || read == 0 {
                            break;
                        }
                        bytes.extend_from_slice(&buffer[..read as usize]);
                    }
                }
                let _ = send.send(bytes);
                Ok(())
            }));
            core.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
                &stream,
                &done,
            )
        })()
    };
    if taken.is_err() {
        let _ = sender.send(Vec::new());
    }
}
