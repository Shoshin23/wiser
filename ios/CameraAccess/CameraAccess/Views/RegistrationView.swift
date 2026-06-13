/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// RegistrationView.swift
//
// Background view that handles callbacks from the Meta AI mobile app during
// DAT SDK registration and permission flows. This invisible view processes deep links
// that complete the OAuth authorization process initiated by the DAT SDK.
//

import MWDATCore
import SwiftUI

struct RegistrationView: View {
  var viewModel: WearablesViewModel

  var body: some View {
    EmptyView()
      // Handle callback URLs from the Meta mobile app
      // This is essential for completing DAT SDK registration and permission flows
      .onOpenURL { url in
        DATLog.log.notice("[Registration] onOpenURL: \(url.absoluteString, privacy: .public)")
        guard
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          // Check if this URL is related to DAT SDK workflows (contains metaWearablesAction query param)
          components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
        else {
          DATLog.log.notice("[Registration] URL ignored — no metaWearablesAction param")
          return // URL is not related to DAT SDK - ignore it
        }
        Task {
          do {
            // Pass the callback URL to the DAT SDK for processing
            // This handles registration completion and permission grant responses
            _ = try await Wearables.shared.handleUrl(url)
            DATLog.log.notice("[Registration] handleUrl succeeded — registration/permission callback processed")
          } catch let error as RegistrationError {
            DATLog.log.error("[Registration] handleUrl RegistrationError: \(error.description, privacy: .public)")
            viewModel.showError(error.description)
          } catch {
            DATLog.log.error("[Registration] handleUrl error: \(error.localizedDescription, privacy: .public)")
            viewModel.showError("Unknown error: \(error.localizedDescription)")
          }
        }
      }
  }
}
